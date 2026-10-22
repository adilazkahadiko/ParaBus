import type {
  WindowsEndpointDirection,
  WindowsEndpointSnapshot,
} from "../../../packages/shared-types/src/index.ts";

/** Small read-only contract implemented by the existing Rust management bridge. */
export interface WindowsDevicePresenceProvider {
  isAvailable(): boolean;
  cachedEndpoint(endpointId: string, direction: WindowsEndpointDirection): WindowsEndpointSnapshot | null;
  refreshEndpoints(): Promise<WindowsEndpointSnapshot[]>;
  onUnavailable?(listener: () => void): () => void;
}
