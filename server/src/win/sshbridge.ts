// The link between the Windows instances and the SSH wiring of the node. The instances are made before the node starts,
// and the SSH wiring needs the node events, so the wiring fills this object in when it is made. Until then an instance
// cannot turn SSH requests on.

export class WinSshBridge {
  /** The variables of an instance that has SSH requests on. A new call gives a new token. */
  env?: (instanceId: string) => Record<string, string>;
  /** A plain reason when SSH requests cannot work now. Undefined when they can. */
  refusal: () => Promise<string | undefined> = () => Promise.resolve("SSH requests are not turned on for this node");
}
