import { chunk } from 'lodash-es';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { Permission, SharedSpaceActivityType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SharedSpaceRepository } from 'src/repositories/shared-space.repository.js';
import { checkAccess } from 'src/utils/access.js';

// Bounds how many cross-owner ids logCrossOwnerEdit will resolve a space for, per bulk edit:
// it does NOT bound how many assets a user may edit. A bulk edit can carry an id list large
// enough that resolving a space (a two-subquery UNION join) for every cross-owner id would fan
// one request out into tens of thousands of heavy queries; logCrossOwnerEdit is best-effort
// activity-feed attribution whose failure is already swallowed, so it is the one place in this
// feature safe to degrade under a huge selection. Never apply this constant to AssetBulkUpdateDto
// or to POST /assets/editable: both must answer for the user's whole selection.
const MAX_ATTRIBUTION_ASSETS = 500;

/**
 * #734: record an edit made by someone who is not the asset owner, so the owner can see
 * what changed and who changed it. Owner self-edits (nearly all editing) log nothing,
 * which is what keeps this low-volume.
 *
 * Grouped by resolved space, one row per space: a bulk edit can span several spaces, and
 * attributing all of it to whichever space resolved first would be wrong. Assets that
 * resolve to no space contribute no row.
 *
 * Never throws. Attribution is secondary to the edit that triggered it.
 */
export const logCrossOwnerEdit = async (
  accessRepository: AccessRepository,
  sharedSpaceRepository: SharedSpaceRepository,
  logger: LoggingRepository,
  auth: AuthDto,
  assetIds: string[],
): Promise<void> => {
  // assetIds arrives here via a zod-validated DTO, so it's already guaranteed to be a real
  // array; this check is defence in depth at the helper boundary, not a suspicion that the
  // DTO lies. It also matters for static analysis: it's what makes the chunking below
  // provably bounded rather than relying on a `.length` that isn't necessarily an array's own.
  if (!Array.isArray(assetIds)) {
    return;
  }

  try {
    // Which of these does the caller own? AssetDelete is the pure owner arm, the same
    // trick rbac-3 uses at :220-223. Deliberately NOT a getByIds fetch: findSpaceForAssetAndUser
    // takes an asset id, so the owner id itself is never needed, and a bulk edit should not pay
    // for a full asset read just to decide whether to write an activity row.
    const ownedIds = await checkAccess(accessRepository, { auth, permission: Permission.AssetDelete, ids: assetIds });
    const crossOwnerIds = assetIds.filter((id) => !ownedIds.has(id));
    if (crossOwnerIds.length === 0) {
      return;
    }

    // findSpaceForAssetAndUser is a UNION of two three-join subqueries; a large cross-owner bulk
    // edit is this feature's headline case, so resolving one id at a time, sequentially, would add
    // a serial-latency term proportional to the batch size. Chunk into bounded-concurrency batches
    // instead of firing all of them at once (connection-pool safety) or one at a time (latency).
    const truncated = crossOwnerIds.length > MAX_ATTRIBUTION_ASSETS;
    const sampledIds = crossOwnerIds.slice(0, MAX_ATTRIBUTION_ASSETS);
    const bySpace = new Map<string, string[]>();
    for (const batch of chunk(sampledIds, 10)) {
      const spaces = await Promise.all(
        batch.map((assetId) => sharedSpaceRepository.findSpaceForAssetAndUser(assetId, auth.user.id)),
      );
      for (const [index, space] of spaces.entries()) {
        if (!space) {
          continue;
        }
        const assetId = batch[index];
        const ids = bySpace.get(space.spaceId) ?? [];
        ids.push(assetId);
        bySpace.set(space.spaceId, ids);
      }
    }

    for (const [spaceId, ids] of bySpace) {
      await sharedSpaceRepository.logActivity({
        spaceId,
        userId: auth.user.id,
        type: SharedSpaceActivityType.AssetEdit,
        data: { count: ids.length, assetIds: ids.slice(0, 4), ...(truncated && { truncated: true }) },
      });
    }
  } catch (error) {
    logger.warn(`Failed to log cross-owner edit activity: ${error}`);
  }
};
