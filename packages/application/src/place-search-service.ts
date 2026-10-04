import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  PlaceSearchCandidate,
  PlaceSearchResponse,
  PlaceSelectionRequest,
} from '@travel/contracts';
import type { Actor } from './authorization.js';
import { ApplicationError } from './errors.js';
import type { TripService } from './trip-service.js';
export interface PlaceSearchProvider {
  search(
    query: string,
    language: string,
    context?: { readonly latitude: number; readonly longitude: number },
  ): Promise<readonly PlaceSearchCandidate[]>;
}
const invalid = () =>
  new ApplicationError(
    'VALIDATION_ERROR',
    '地点候选已失效，请重新搜索并明确选择。',
    400,
  );
/** No database/cache writes. Authenticated, owner/Trip-bound selection evidence. */
export class PlaceSearchService {
  private readonly key = randomBytes(32);
  private readonly attempts = new Map<string, number>();
  private calls = 0;
  private day = '';
  constructor(
    private readonly provider: PlaceSearchProvider,
    private readonly trips: Pick<TripService, 'getTrip' | 'executeAuthoring'>,
    private readonly now: () => Date = () => new Date(),
    private readonly maxDailyCalls = 100,
  ) {}
  async search(
    actor: Actor,
    tripId: string,
    query: string,
    language = 'ja',
    contextNodeId?: string,
  ): Promise<PlaceSearchResponse> {
    const trip = await this.trips.getTrip(actor, tripId);
    const context =
      contextNodeId === undefined
        ? undefined
        : trip.days
            .flatMap((day) => day.nodes)
            .find((node) => node.id === contextNodeId)?.place;
    if (contextNodeId !== undefined && !context) throw invalid();
    if (
      typeof query !== 'string' ||
      !query.trim() ||
      query.trim().length > 200 ||
      !['ja', 'en', 'zh'].includes(language)
    )
      throw invalid();
    const now = this.now();
    if (now.getTime() - (this.attempts.get(actor.userId) ?? 0) < 2000)
      throw new ApplicationError(
        'PLACE_SEARCH_UNAVAILABLE',
        '搜索过于频繁，请稍后重试。',
        503,
      );
    if (this.day !== now.toISOString().slice(0, 10)) {
      this.day = now.toISOString().slice(0, 10);
      this.calls = 0;
      this.attempts.clear();
    }
    if (this.calls >= this.maxDailyCalls)
      throw new ApplicationError(
        'PLACE_SEARCH_UNAVAILABLE',
        '地点搜索暂时不可用，仍可选择已保存地点。',
        503,
      );
    this.attempts.set(actor.userId, now.getTime());
    this.calls++;
    const expiresAt = new Date(now.getTime() + 86400000).toISOString();
    let candidates: readonly PlaceSearchCandidate[];
    try {
      candidates = await this.provider.search(
        query.trim(),
        language,
        context ?? undefined,
      );
    } catch {
      throw new ApplicationError(
        'PLACE_SEARCH_UNAVAILABLE',
        '地点搜索暂时不可用，仍可选择已保存地点。',
        503,
      );
    }
    return {
      expiresAt,
      candidates: candidates.slice(0, 5).map((candidate) => {
        const payload = Buffer.from(
          JSON.stringify({ owner: actor.userId, tripId, expiresAt, candidate }),
        ).toString('base64url');
        return {
          ...candidate,
          selectionToken: `${payload}.${this.sign(payload)}`,
        };
      }),
    };
  }
  async select(actor: Actor, tripId: string, input: PlaceSelectionRequest) {
    await this.trips.getTrip(actor, tripId);
    const token = input.selectionToken;
    if (typeof token !== 'string' || token.length > 10000) throw invalid();
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) throw invalid();
    const a = Buffer.from(signature),
      b = Buffer.from(this.sign(payload));
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalid();
    let evidence: {
      owner: string;
      tripId: string;
      expiresAt: string;
      candidate: PlaceSearchCandidate;
    };
    try {
      evidence = JSON.parse(Buffer.from(payload, 'base64url').toString());
    } catch {
      throw invalid();
    }
    if (
      evidence.owner !== actor.userId ||
      evidence.tripId !== tripId ||
      new Date(evidence.expiresAt).getTime() <= this.now().getTime()
    )
      throw invalid();
    const c = evidence.candidate;
    if (!c.coordinates)
      throw new ApplicationError(
        'VALIDATION_ERROR',
        '这个候选没有可靠坐标，不可加入为可导航地点。请选择其他候选。',
        400,
      );
    if (
      input.note != null &&
      (typeof input.note !== 'string' || input.note.length > 1200)
    )
      throw invalid();
    return this.trips.executeAuthoring(actor, tripId, {
      baseTripVersion: input.baseTripVersion,
      idempotencyKey: input.idempotencyKey,
      command: {
        type: 'ADD_PLACE_VISIT',
        targetDay: input.targetDay,
        position: input.position,
        place: {
          type: 'CUSTOM',
          name: c.name,
          address: c.formattedAddress,
          ...c.coordinates,
        },
        note: [
          input.note,
          `地点来源：${c.attribution}；${c.provider} ID：${c.externalId}${c.synthetic ? '（SYNTHETIC）' : ''}`,
        ]
          .filter(Boolean)
          .join('\n'),
      },
    });
  }
  private sign(payload: string) {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }
}
