import Emittery from "emittery";
import type { Hex } from "viem";

import type { Network } from "@/config/networks.js";
import type { Source } from "@/config/sources.js";
import { sourceIsFactory, sourceIsLogFilter } from "@/config/sources.js";
import type { Common } from "@/Ponder.js";
import type { SyncStore } from "@/sync-store/store.js";
import {
  type Checkpoint,
  checkpointMax,
  checkpointMin,
  isCheckpointGreaterThan,
  zeroCheckpoint,
} from "@/utils/checkpoint.js";

type SyncGatewayEvents = {
  /**
   * Emitted when a new event checkpoint is reached. This is the minimum timestamp
   * at which events are available across all registered networks.
   */
  newCheckpoint: Checkpoint;
  /**
   * Emitted when a new finality checkpoint is reached. This is the minimum timestamp
   * at which events are finalized across all registered networks.
   */
  newFinalityCheckpoint: Checkpoint;
  /**
   * Emitted when a reorg has been detected on any registered network. The value
   * is the safe/"common ancestor" checkpoint.
   */
  reorg: Checkpoint;
};

type SyncGatewayMetrics = {};

export class SyncGateway extends Emittery<SyncGatewayEvents> {
  private common: Common;
  private syncStore: SyncStore;
  private networks: Network[];
  private sources: Source[];

  // Minimum timestamp at which events are available (across all networks).
  checkpoint: Checkpoint;
  // Minimum finalized timestamp (across all networks).
  finalityCheckpoint: Checkpoint;

  // Per-network event timestamp checkpoints.
  private networkCheckpoints: Record<
    number,
    {
      isHistoricalSyncComplete: boolean;
      historicalCheckpoint: Checkpoint;
      realtimeCheckpoint: Checkpoint;
      finalityCheckpoint: Checkpoint;
    }
  >;

  // Timestamp at which the historical sync was completed (across all networks).
  historicalSyncCompletedAt?: number;

  metrics: SyncGatewayMetrics;

  constructor({
    common,
    syncStore,
    networks,
    sources = [],
  }: {
    common: Common;
    syncStore: SyncStore;
    networks: Network[];
    sources?: Source[];
  }) {
    super();

    this.common = common;
    this.syncStore = syncStore;
    this.networks = networks;
    this.sources = sources;
    this.metrics = {};

    this.checkpoint = zeroCheckpoint;
    this.finalityCheckpoint = zeroCheckpoint;

    this.networkCheckpoints = {};
    this.networks.forEach((network) => {
      const { chainId } = network;
      this.networkCheckpoints[chainId] = {
        isHistoricalSyncComplete: false,
        historicalCheckpoint: zeroCheckpoint,
        realtimeCheckpoint: zeroCheckpoint,
        finalityCheckpoint: zeroCheckpoint,
      };
    });
  }

  /** Fetches events for all registered log filters between the specified checkpoints.
   *
   * @param options.fromCheckpoint Checkpoint to include events from (exclusive).
   * @param options.toCheckpoint Checkpoint to include events to (inclusive).
   * @param options.includeLogFilterEvents Map of log filter name -> selector -> ABI event
   * item for which to include full event objects.
   * @returns An async interator of event pages.
   */
  getEvents({
    fromCheckpoint,
    toCheckpoint,
    includeEventSelectors,
  }: {
    fromCheckpoint: Checkpoint;
    toCheckpoint: Checkpoint;
    includeEventSelectors: { [sourceId: string]: Hex[] };
  }) {
    return this.syncStore.getLogEvents({
      fromCheckpoint,
      toCheckpoint,
      logFilters: this.sources.filter(sourceIsLogFilter).map((logFilter) => ({
        id: logFilter.id,
        chainId: logFilter.chainId,
        criteria: logFilter.criteria,
        fromBlock: logFilter.startBlock,
        toBlock: logFilter.endBlock,
        includeEventSelectors: includeEventSelectors[logFilter.id],
      })),
      factories: this.sources.filter(sourceIsFactory).map((factory) => ({
        id: factory.id,
        chainId: factory.chainId,
        criteria: factory.criteria,
        fromBlock: factory.startBlock,
        toBlock: factory.endBlock,
        includeEventSelectors: includeEventSelectors[factory.id],
      })),
    });
  }

  handleNewHistoricalCheckpoint = (checkpoint: Checkpoint) => {
    const { blockTimestamp, chainId, blockNumber } = checkpoint;

    this.networkCheckpoints[chainId].historicalCheckpoint = checkpoint;

    this.common.logger.trace({
      service: "gateway",
      msg: `New historical checkpoint (timestamp=${blockTimestamp} chainId=${chainId} blockNumber=${blockNumber})`,
    });

    this.recalculateCheckpoint();
  };

  handleHistoricalSyncComplete = ({ chainId }: { chainId: number }) => {
    this.networkCheckpoints[chainId].isHistoricalSyncComplete = true;
    this.recalculateCheckpoint();

    // If every network has completed the historical sync, set the metric.
    const networkCheckpoints = Object.values(this.networkCheckpoints);
    if (networkCheckpoints.every((n) => n.isHistoricalSyncComplete)) {
      const maxHistoricalCheckpoint = checkpointMax(
        ...networkCheckpoints.map((n) => n.historicalCheckpoint),
      );
      this.historicalSyncCompletedAt = maxHistoricalCheckpoint.blockTimestamp;

      this.common.logger.debug({
        service: "gateway",
        msg: `Completed historical sync across all networks`,
      });
    }
  };

  handleNewRealtimeCheckpoint = (checkpoint: Checkpoint) => {
    const { blockTimestamp, chainId, blockNumber } = checkpoint;

    this.networkCheckpoints[chainId].realtimeCheckpoint = checkpoint;

    this.common.logger.trace({
      service: "gateway",
      msg: `New realtime checkpoint at (timestamp=${blockTimestamp} chainId=${chainId} blockNumber=${blockNumber})`,
    });

    this.recalculateCheckpoint();
  };

  handleNewFinalityCheckpoint = (checkpoint: Checkpoint) => {
    const { chainId } = checkpoint;

    this.networkCheckpoints[chainId].finalityCheckpoint = checkpoint;
    this.recalculateFinalityCheckpoint();
  };

  handleReorg = (checkpoint: Checkpoint) => {
    this.emit("reorg", checkpoint);
  };

  /** Resets global checkpoints as well as the network checkpoint for the specified chain ID.
   *  Keeps previous checkpoint values for other networks.
   *
   * @param options.chainId Chain ID for which to reset the checkpoint.
   */
  resetCheckpoints = ({ chainId }: { chainId: number }) => {
    this.checkpoint = zeroCheckpoint;
    this.finalityCheckpoint = zeroCheckpoint;
    this.historicalSyncCompletedAt = 0;
    this.networkCheckpoints[chainId] = {
      isHistoricalSyncComplete: false,
      historicalCheckpoint: zeroCheckpoint,
      realtimeCheckpoint: zeroCheckpoint,
      finalityCheckpoint: zeroCheckpoint,
    };
  };

  private recalculateCheckpoint = () => {
    const checkpoints = Object.values(this.networkCheckpoints).map((n) =>
      n.isHistoricalSyncComplete
        ? checkpointMax(n.historicalCheckpoint, n.realtimeCheckpoint)
        : n.historicalCheckpoint,
    );
    const newCheckpoint = checkpointMin(...checkpoints);

    if (isCheckpointGreaterThan(newCheckpoint, this.checkpoint)) {
      this.checkpoint = newCheckpoint;

      const { chainId, blockTimestamp, blockNumber } = this.checkpoint;
      this.common.logger.trace({
        service: "gateway",
        msg: `New checkpoint (timestamp=${blockTimestamp} chainId=${chainId} blockNumber=${blockNumber})`,
      });

      this.emit("newCheckpoint", this.checkpoint);
    }
  };

  private recalculateFinalityCheckpoint = () => {
    const newFinalityCheckpoint = checkpointMin(
      ...Object.values(this.networkCheckpoints).map(
        (n) => n.finalityCheckpoint,
      ),
    );

    if (
      isCheckpointGreaterThan(newFinalityCheckpoint, this.finalityCheckpoint)
    ) {
      this.finalityCheckpoint = newFinalityCheckpoint;

      const { chainId, blockTimestamp, blockNumber } = this.finalityCheckpoint;
      this.common.logger.trace({
        service: "gateway",
        msg: `New finality checkpoint (timestamp=${blockTimestamp} chainId=${chainId} blockNumber=${blockNumber})`,
      });

      this.emit("newFinalityCheckpoint", this.finalityCheckpoint);
    }
  };
}
