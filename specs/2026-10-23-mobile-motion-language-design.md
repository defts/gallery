# Mobile motion language

Status: first wave implemented. Code: `mobile/lib/gallery/motion/`. Companion to
`specs/2026-10-23-web-motion-language-design.md` (web motion PR #1235); the goal, the rules and the token values are the
same, so the two apps move alike.

## Why

Opening the app felt cheap: a static splash logo cut to a spinning logo on an empty screen, then the
whole grid switched on at once (each tile faded from grey in 100ms). Tabs cross-faded for 600ms from
an empty frame, so a tab switch felt slow. Nothing responded to a finger.

## What this wave does

| Moment                        | Before                                         | Now                                                                                                    | Where                                    |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Splash → app shell, login → shell | Platform push (iOS slides in from the right) | The shell fades in while settling from 104% (420ms, settle curve): the splash dissolves into the grid | `transitions.dart`, `router.dart` fork block |
| Timeline loading              | Rainbow-ring spinning logo, centred            | Skeleton grid in the real layout (columns, spacing, month headers) with a slow diagonal sheen           | `timeline_skeleton.dart`                 |
| Photos arriving               | Grid switches on                               | The skeleton's copy wipes away in a soft diagonal wave from the top-left (520ms); photos are live under it | `timeline_skeleton.dart`, `wave_mask.dart` |
| Each thumbnail decoding       | 100ms fade                                     | 160ms (`GalleryMotion.quick`) fade from the thumbhash                                                    | `thumbnail.widget.dart` (one token)       |
| Switching tabs                | 600ms linear fade from empty                   | 260ms: fade in over the first 60%, settle from 98.5%                                                    | `transitions.dart`, fork tab shell        |
| Pressing a nav tab / search   | Colour change only                             | Squish to 88% / 86%, spring back on the bouncy spring; a quick tap waits for the dip to land           | `pressable.dart`, fork nav widgets       |

Pages pushed on top of the shell keep the platform's own transitions (iOS Cupertino slide with edge
swipe-back, Android predictive back with fade-forwards, both Flutter's defaults). They are already
good and changing them would touch the theme and the iOS swipe-back fix (#899) for no gain. The shell's
custom route hands its `secondaryAnimation` to the theme's builder so the shell still makes the
platform's exit when something is pushed over it.

## Tokens

`motion_tokens.dart` mirrors web's `tokens.ts`: durations `instant` 90ms, `quick` 160ms, `base` 240ms,
`slow` 400ms; curves `standard` (0.2, 0, 0, 1), `settle` (0.22, 1, 0.36, 1), `exit` (0.3, 0, 0.8,
0.15); springs `gentle` (k 300, c 22), `snappy` (k 600, c 34), `bouncy` (k 380, c 16), all mass 1.
Flutter runs the springs natively (`SpringSimulation`), so there is no sampled `linear()` table.

## Rules

Web's rules apply. On mobile in particular:

1. **Never block.** The load wave ignores touches and the photos under it are live from the first frame.
2. **Reduced motion** (`MediaQuery.disableAnimations`, the OS setting): no squish, no settle or scale;
   the sheen stands still, the wave becomes a 160ms fade, transitions only fade.
3. **Raw pointers for press feedback.** `GalleryPressable` listens with a `Listener`, so it never joins
   the gesture arena and cannot change what a tap, long-press or drag does.
4. **The wave departs from the skeleton, not around the timeline.** Wrapping the timeline body would
   re-indent ~250 lines of `timeline.widget.dart`. Instead the skeleton, on `deactivate`, inserts a
   frozen copy of itself into the overlay at its own on-screen rect, and that copy wipes itself away.
   It is skipped when the skeleton's route is not current (a page was pushed over it, or it is being
   popped). It stops `bottomNavHeightProvider` short of the bottom so it never paints over the floating
   nav pill.
5. **Layering.** All logic lives in `mobile/lib/gallery/motion/`. Fork files (tab shell, nav pill,
   search blob, the `router.dart` fork block) call it directly.

## Upstream hooks

| Upstream file                                          | Change                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `presentation/widgets/timeline/timeline.widget.dart`   | The loading sliver is `GalleryTimelineSkeleton()` instead of the spinner; one import swapped |
| `presentation/widgets/images/thumbnail.widget.dart`    | Fade duration reads `GalleryMotion.quick`; one import                      |
| `routing/router.dart`                                  | One import; the shell route change sits inside the existing fork block    |

## Next candidates

- Opening a photo: the thumbnail → viewer `Hero` already exists; a springier flight and corner-radius
  morph need a `flightShuttleBuilder` on the upstream thumbnail tile.
- Press feedback on photo tiles and cards (upstream tile; needs a hook).
- Rewards as on web: a heart burst on favourite, photos thrown toward the trash or archive. The asset
  action service is the single path, so one hook there would cover the viewer and the selection bar.
- The skeleton for album, Space and search timelines comes for free (same widget); other loading
  screens still show `ImmichLoadingIndicator`.
- Search is out of scope here: it is getting a redesign.
