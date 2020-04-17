// @flow strict-local

import type {AbortSignal} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
import type {File, FilePath, Glob} from '@parcel/types';
import type {Event} from '@parcel/watcher';
import type WorkerFarm from '@parcel/workers';
import type {NodeId, ParcelOptions} from './types';

import invariant from 'assert';
import nullthrows from 'nullthrows';
import {isGlobMatch, md5FromObject} from '@parcel/utils';
import Graph, {type GraphOpts} from './Graph';
import {assertSignalNotAborted} from './utils';

type SerializedRequestGraph = {|
  ...GraphOpts<RequestGraphNode, RequestGraphEdgeType>,
  invalidNodeIds: Set<NodeId>,
  incompleteNodeIds: Set<NodeId>,
  globNodeIds: Set<NodeId>,
  unpredicatableNodeIds: Set<NodeId>,
|};

type FileNode = {|id: string, +type: 'file', value: File|};
type GlobNode = {|id: string, +type: 'glob', value: Glob|};
export type RequestBlah = {|
  id: string,
  +type: string,
  request: mixed,
  result?: mixed,
|};

type RequestNode = {|
  id: string,
  +type: 'request',
  value: RequestBlah,
|};
type RequestGraphNode = RequestNode | FileNode | GlobNode;

type RequestGraphEdgeType =
  | 'subrequest'
  | 'invalidated_by_update'
  | 'invalidated_by_delete'
  | 'invalidated_by_create';

const nodeFromFilePath = (filePath: string) => ({
  id: filePath,
  type: 'file',
  value: {filePath},
});

const nodeFromGlob = (glob: Glob) => ({
  id: glob,
  type: 'glob',
  value: glob,
});

const nodeFromRequest = (request: RequestBlah) => ({
  id: request.id,
  type: 'request',
  value: request,
});

export class RequestGraph extends Graph<
  RequestGraphNode,
  RequestGraphEdgeType,
> {
  invalidNodeIds: Set<NodeId> = new Set();
  incompleteNodeIds: Set<NodeId> = new Set();
  globNodeIds: Set<NodeId> = new Set();
  // Unpredictable nodes are requests that cannot be predicted whether they should rerun based on
  // filesystem changes alone. They should rerun on each startup of Parcel.
  unpredicatableNodeIds: Set<NodeId> = new Set();

  // $FlowFixMe
  static deserialize(opts: SerializedRequestGraph) {
    // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381
    let deserialized = new RequestGraph(opts);
    deserialized.invalidNodeIds = opts.invalidNodeIds;
    deserialized.incompleteNodeIds = opts.incompleteNodeIds;
    deserialized.globNodeIds = opts.globNodeIds;
    deserialized.unpredicatableNodeIds = opts.unpredicatableNodeIds;
    // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381 (Windows only)
    return deserialized;
  }

  // $FlowFixMe
  serialize(): SerializedRequestGraph {
    return {
      ...super.serialize(),
      invalidNodeIds: this.invalidNodeIds,
      incompleteNodeIds: this.incompleteNodeIds,
      globNodeIds: this.globNodeIds,
      unpredicatableNodeIds: this.unpredicatableNodeIds,
    };
  }

  addNode(node: RequestGraphNode) {
    if (!this.hasNode(node.id)) {
      if (node.type === 'glob') {
        this.globNodeIds.add(node.id);
      }
    }

    return super.addNode(node);
  }

  removeNode(node: RequestGraphNode) {
    this.invalidNodeIds.delete(node.id);
    this.incompleteNodeIds.delete(node.id);
    if (node.type === 'glob') {
      this.globNodeIds.delete(node.id);
    }
    return super.removeNode(node);
  }

  // TODO: deprecate
  addRequest(request: RequestBlah) {
    let requestNode = nodeFromRequest(request);
    if (!this.hasNode(requestNode.id)) {
      this.addNode(requestNode);
    } else {
      requestNode = this.getNode(requestNode.id);
    }
    return requestNode;
  }

  getRequestNode(id: string) {
    let node = nullthrows(this.getNode(id));
    invariant(node.type === 'request');
    return node;
  }

  completeRequest(request: RequestBlah) {
    this.invalidNodeIds.delete(request.id);
    this.incompleteNodeIds.delete(request.id);
  }

  replaceSubrequests(
    requestId: string,
    subrequestNodes: Array<RequestGraphNode>,
  ) {
    let requestNode = this.getRequestNode(requestId);
    if (!this.hasNode(requestId)) {
      this.addNode(requestNode);
    }

    for (let subrequestNode of subrequestNodes) {
      this.invalidNodeIds.delete(subrequestNode.id);
    }

    this.replaceNodesConnectedTo(
      requestNode,
      subrequestNodes,
      null,
      'subrequest',
    );
  }

  invalidateNode(node: RequestGraphNode) {
    invariant(node.type === 'request');
    if (this.hasNode(node.id)) {
      this.invalidNodeIds.add(node.id);
      this.clearInvalidations(node);

      let parentNodes = this.getNodesConnectedTo(node, 'subrequest');
      for (let parentNode of parentNodes) {
        this.invalidateNode(parentNode);
      }
    }
  }

  invalidateUnpredictableNodes() {
    for (let nodeId of this.unpredicatableNodeIds) {
      let node = nullthrows(this.getNode(nodeId));
      invariant(node.type !== 'file' && node.type !== 'glob');
      this.invalidateNode(node);
    }
  }

  invalidateOnFileUpdate(requestId: string, filePath: FilePath) {
    let requestNode = this.getRequestNode(requestId);
    let fileNode = nodeFromFilePath(filePath);
    if (!this.hasNode(fileNode.id)) {
      this.addNode(fileNode);
    }

    if (!this.hasEdge(requestNode.id, fileNode.id, 'invalidated_by_update')) {
      this.addEdge(requestNode.id, fileNode.id, 'invalidated_by_update');
    }
  }

  invalidateOnFileDelete(requestId: string, filePath: FilePath) {
    let requestNode = this.getRequestNode(requestId);
    let fileNode = nodeFromFilePath(filePath);
    if (!this.hasNode(fileNode.id)) {
      this.addNode(fileNode);
    }

    if (!this.hasEdge(requestNode.id, fileNode.id, 'invalidated_by_delete')) {
      this.addEdge(requestNode.id, fileNode.id, 'invalidated_by_delete');
    }
  }

  invalidateOnFileCreate(requestId: string, glob: Glob) {
    let requestNode = this.getRequestNode(requestId);
    let globNode = nodeFromGlob(glob);
    if (!this.hasNode(globNode.id)) {
      this.addNode(globNode);
    }

    if (!this.hasEdge(requestNode.id, globNode.id, 'invalidated_by_create')) {
      this.addEdge(requestNode.id, globNode.id, 'invalidated_by_create');
    }
  }

  invalidateOnStartup(requestId: string) {
    let requestNode = this.getRequestNode(requestId);
    this.unpredicatableNodeIds.add(requestNode.id);
  }

  clearInvalidations(node: RequestNode) {
    this.unpredicatableNodeIds.delete(node.id);
    this.replaceNodesConnectedTo(node, [], null, 'invalidated_by_update');
    this.replaceNodesConnectedTo(node, [], null, 'invalidated_by_delete');
    this.replaceNodesConnectedTo(node, [], null, 'invalidated_by_create');
  }

  respondToFSEvents(events: Array<Event>): boolean {
    for (let {path, type} of events) {
      let node = this.getNode(path);

      // sometimes mac os reports update events as create events
      // if it was a create event, but the file already exists in the graph,
      // then we can assume it was actually an update event
      if (node && (type === 'create' || type === 'update')) {
        for (let connectedNode of this.getNodesConnectedTo(
          node,
          'invalidated_by_update',
        )) {
          this.invalidateNode(connectedNode);
        }
      } else if (type === 'create') {
        for (let id of this.globNodeIds) {
          let globNode = this.getNode(id);
          invariant(globNode && globNode.type === 'glob');

          if (isGlobMatch(path, globNode.value)) {
            let connectedNodes = this.getNodesConnectedTo(
              globNode,
              'invalidated_by_create',
            );
            for (let connectedNode of connectedNodes) {
              this.invalidateNode(connectedNode);
            }
          }
        }
      } else if (node && type === 'delete') {
        for (let connectedNode of this.getNodesConnectedTo(
          node,
          'invalidated_by_delete',
        )) {
          this.invalidateNode(connectedNode);
        }
      }
    }

    return this.invalidNodeIds.size > 0;
  }
}

export default class RequestTracker {
  graph: RequestGraph;
  farm: WorkerFarm;
  options: ParcelOptions;
  signal: ?AbortSignal;

  constructor({
    graph,
    farm,
    options,
  }: {|
    graph: RequestGraph,
    farm: WorkerFarm,
    options: ParcelOptions,
  |}) {
    this.graph = graph || new RequestGraph();
    this.farm = farm;
    this.options = options;
  }

  // TODO: refactor (abortcontroller should be created by RequestTracker)
  setSignal(signal?: AbortSignal) {
    this.signal = signal;
  }

  isTracked(id: string) {
    return this.graph.hasNode(id);
  }

  getRequest(id: string) {
    return nullthrows(this.graph.getNode(id));
  }

  trackRequest(request: RequestBlah) {
    if (this.isTracked(request.id)) {
      return;
    }

    this.graph.incompleteNodeIds.add(request.id);
    this.graph.invalidNodeIds.delete(request.id);
    let node = nodeFromRequest(request);
    this.graph.addNode(node);
  }

  untrackRequest(id: string) {
    this.graph.removeById(id);
  }

  storeResult(id: string, result: mixed) {
    let node = this.graph.getNode(id);
    if (node && node.type === 'request') {
      node.value.result = result;
    }
  }

  hasValidResult(id: string) {
    return (
      this.graph.nodes.has(id) &&
      !this.graph.invalidNodeIds.has(id) &&
      !this.graph.incompleteNodeIds.has(id)
    );
  }

  getRequestResult(id: string) {
    let node = nullthrows(this.graph.getNode(id));
    invariant(node.type === 'request');
    return node.value.result;
  }

  completeRequest(id: string) {
    this.graph.invalidNodeIds.delete(id);
    this.graph.incompleteNodeIds.delete(id);
  }

  rejectRequest(id: string) {
    this.graph.incompleteNodeIds.delete(id);
    if (this.graph.hasNode(id)) {
      this.graph.invalidNodeIds.add(id);
    }
  }

  respondToFSEvents(events: Array<Event>): boolean {
    return this.graph.respondToFSEvents(events);
  }

  hasInvalidRequests() {
    return this.graph.invalidNodeIds.size > 0;
  }

  getInvalidRequests(): Array<RequestBlah> {
    let invalidRequests = [];
    for (let id of this.graph.invalidNodeIds) {
      let node = nullthrows(this.graph.getNode(id));
      invariant(node.type === 'request');
      invalidRequests.push(node.value);
    }
    return invalidRequests;
  }

  replaceSubrequests(
    requestId: string,
    subrequestNodes: Array<RequestGraphNode>,
  ) {
    this.graph.replaceSubrequests(requestId, subrequestNodes);
  }

  makeRequest(request: Request) {
    return async (input: mixed) => {
      let id = this.generateRequestId(request, input);
      try {
        let api = this.createAPI(id);

        this.trackRequest({id, type: request.type, request: input});
        let result: mixed = this.hasValidResult(id)
          ? // TODO: figure out how to type safely
            // $FlowFixMe
            (this.getRequestResult(id): any)
          : await request.run({
              input,
              api,
              farm: this.farm,
              options: this.options,
              graph: this.graph,
            });
        assertSignalNotAborted(this.signal);
        this.completeRequest(id);

        return result;
      } catch (err) {
        this.rejectRequest(id);
        throw err;
      }
    };
  }

  createAPI(requestId: string): RequestRunnerAPI {
    let api = {
      invalidateOnFileCreate: glob =>
        this.graph.invalidateOnFileCreate(requestId, glob),
      invalidateOnFileDelete: filePath =>
        this.graph.invalidateOnFileDelete(requestId, filePath),
      invalidateOnFileUpdate: filePath =>
        this.graph.invalidateOnFileUpdate(requestId, filePath),
      invalidateOnStartup: () => this.graph.invalidateOnStartup(requestId),
      replaceSubrequests: subrequestNodes =>
        this.graph.replaceSubrequests(requestId, subrequestNodes),
      storeResult: result => {
        this.storeResult(requestId, result);
      },
    };

    return api;
  }

  generateRequestId(request: Request, input: mixed) {
    return `${request.type}:${request.getId(input)}`;
  }
}

export type RequestRunnerOpts = {|tracker: RequestTracker|};

export type RunRequestOpts = {|
  signal?: ?AbortSignal,
  parentId?: string,
  extras?: mixed,
|};

export type StaticRunOpts = {|
  farm: WorkerFarm,
  options: ParcelOptions,
  api: RequestRunnerAPI,
  extras: mixed,
  graph: RequestGraph,
|};

export type RequestRunnerAPI = {|
  invalidateOnFileCreate: Glob => void,
  invalidateOnFileDelete: FilePath => void,
  invalidateOnFileUpdate: FilePath => void,
  invalidateOnStartup: () => void,
  replaceSubrequests: (Array<RequestGraphNode>) => void,
  storeResult: (result: mixed) => void,
|};

export function generateRequestId(type: string, request: mixed) {
  return md5FromObject({type, request});
}

type Request = {|
  type: string,
  run: mixed => mixed,
  getId: mixed => string,
|};

export class RequestRunner<TRequest, TResult> {
  type: string;
  // $FlowFixMe RequestRunner will be removed during refactor
  tracker: RequestTracker<any>;

  constructor({tracker}: RequestRunnerOpts) {
    this.tracker = tracker;
  }

  async runRequest({
    request,
    signal,
    extras,
  }: {|
    request: TRequest,
    ...RunRequestOpts,
  |}): Promise<TResult | void> {
    let id = this.generateRequestId(request);
    try {
      let api = this.createAPI(id);

      let {farm, options} = this.tracker;
      this.tracker.trackRequest({id, type: this.type, request: request});
      let result: TResult = this.tracker.hasValidResult(id)
        ? // $FlowFixMe
          (this.tracker.getRequestResult(id): any)
        : await this.run({
            request: request,
            api,
            farm,
            options,
            extras,
            graph: this.tracker.graph,
          });
      assertSignalNotAborted(signal);
      this.tracker.completeRequest(id);

      return result;
    } catch (err) {
      this.tracker.rejectRequest(id);
      throw err;
    }
  }

  // unused vars are used for types
  // eslint-disable-next-line no-unused-vars
  run(obj: {|request: TRequest, ...StaticRunOpts|}): Promise<TResult> {
    throw new Error(
      `RequestRunner for type ${this.type} did not implement run()`,
    );
  }

  generateRequestId(request: TRequest) {
    return md5FromObject({type: this.type, request});
  }

  createAPI(requestId: string): RequestRunnerAPI {
    let api = {
      invalidateOnFileCreate: glob =>
        this.tracker.graph.invalidateOnFileCreate(requestId, glob),
      invalidateOnFileDelete: filePath =>
        this.tracker.graph.invalidateOnFileDelete(requestId, filePath),
      invalidateOnFileUpdate: filePath =>
        this.tracker.graph.invalidateOnFileUpdate(requestId, filePath),
      invalidateOnStartup: () =>
        this.tracker.graph.invalidateOnStartup(requestId),
      replaceSubrequests: subrequestNodes =>
        this.tracker.graph.replaceSubrequests(requestId, subrequestNodes),
      storeResult: result => {
        this.tracker.storeResult(requestId, result);
      },
    };

    return api;
  }
}
