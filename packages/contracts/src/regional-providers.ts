export type ProviderRegion = 'MAINLAND_CHINA' | 'JAPAN' | 'GLOBAL_OTHER';
/** Routing policy only. Does not promise configured SDK, license or map delivery. */
export interface RegionalMapCapabilityView {
  readonly region: ProviderRegion | null;
  readonly provider: 'BAIDU' | 'GOOGLE' | null;
  readonly coordinates: {
    readonly latitude: number;
    readonly longitude: number;
  };
  readonly coordinateSystem: 'WGS84';
}
