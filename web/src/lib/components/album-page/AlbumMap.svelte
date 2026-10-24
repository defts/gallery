<script lang="ts">
  import type { FilterState } from '$lib/components/filter-panel/filter-panel';
  import { getFilteredAlbumMapMarkersQuery } from '$lib/gallery/album/album-map.query';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import MapModal from '$lib/modals/MapModal.svelte';
  import { getAlbumMapMarkersQuery } from '$lib/queries/album.query';
  import { queryClient } from '$lib/queries/client';
  import { buildAlbumMapMarkerOptions } from '$lib/utils/map-filter-options';
  import { navigate } from '$lib/utils/navigation';
  import { type AlbumResponseDto } from '@immich/sdk';
  import { IconButton, modalManager } from '@immich/ui';
  import { mdiMapOutline } from '@mdi/js';
  import { createQuery } from '@tanstack/svelte-query';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    album: AlbumResponseDto;
    /**
     * Gallery (#767): the album's LIVE filter state. Absent on the shared-link album view
     * (AlbumViewer.svelte), which must keep using the album endpoint: /gallery/map/markers takes no
     * shared-link key, and a shared link exposes no filter affordances anyway (E2).
     */
    filters?: FilterState;
  }

  let { album, filters }: Props = $props();

  let returnToMap = $state(false);
  const markerOptions = $derived(
    filters && !authManager.isSharedLink ? buildAlbumMapMarkerOptions(album.id, filters) : undefined,
  );
  const query = createQuery(
    () => ({ ...getAlbumMapMarkersQuery(album.id), enabled: !markerOptions }),
    () => queryClient,
  );
  const filteredQuery = createQuery(
    () => ({ ...getFilteredAlbumMapMarkersQuery(album.id, markerOptions ?? {}), enabled: !!markerOptions }),
    () => queryClient,
  );
  const mapMarkers = $derived((markerOptions ? filteredQuery.data : query.data) ?? []);

  onDestroy(() => {
    assetViewerManager.showAssetViewer(false);
  });

  $effect(() => {
    if (assetViewerManager.isViewing || !returnToMap) {
      return;
    }

    returnToMap = false;
    void onClick();
  });

  const onClick = async () => {
    const assetIds = await modalManager.show(MapModal, { mapMarkers });
    if (assetIds) {
      await navigate({ targetRoute: 'current', assetId: assetIds[0] });
      returnToMap = true;
    } else {
      returnToMap = false;
    }
  };
</script>

<IconButton
  variant="ghost"
  shape="round"
  color="secondary"
  icon={mdiMapOutline}
  onclick={onClick}
  aria-label={$t('map')}
/>
