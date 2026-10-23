import 'dart:async';

import 'package:flutter/physics.dart';
import 'package:flutter/widgets.dart';
import 'package:immich_mobile/gallery/motion/motion_tokens.dart';

/// Squishes [child] while a finger is down and springs it back on release.
///
/// Listens to raw pointer events, so it never competes with the child's own gesture detectors: taps,
/// long presses and drags reach the child unchanged. A quick tap waits for the dip to land before
/// springing back, so the press is visible even when the finger lifts at once.
class GalleryPressable extends StatefulWidget {
  final Widget child;

  /// Scale while pressed. Web uses 0.86–0.95; small controls take the deeper end.
  final double pressedScale;

  final bool enabled;

  const GalleryPressable({super.key, required this.child, this.pressedScale = 0.92, this.enabled = true});

  @override
  State<GalleryPressable> createState() => _GalleryPressableState();
}

class _GalleryPressableState extends State<GalleryPressable> with SingleTickerProviderStateMixin {
  late final AnimationController _scale = AnimationController.unbounded(vsync: this, value: 1.0);
  int _pointers = 0;
  TickerFuture? _dip;

  @override
  void dispose() {
    _scale.dispose();
    super.dispose();
  }

  void _down(PointerDownEvent _) {
    _pointers++;
    if (!widget.enabled || GalleryMotion.reduced(context)) {
      return;
    }
    _dip = _scale.animateTo(widget.pressedScale, duration: GalleryMotion.instant, curve: GalleryMotion.standard);
  }

  void _up(PointerEvent _) {
    _pointers = (_pointers - 1).clamp(0, 1 << 30);
    if (_pointers > 0) {
      return;
    }
    final dip = _dip;
    if (dip != null && _scale.isAnimating) {
      // A stopped ticker never completes this future, so a newer press simply drops this release.
      unawaited(dip.whenComplete(_release));
    } else {
      _release();
    }
  }

  void _release() {
    if (!mounted || _pointers > 0) {
      return;
    }
    _dip = null;
    _scale.animateWith(SpringSimulation(GalleryMotion.bouncy, _scale.value, 1.0, _scale.velocity));
  }

  @override
  Widget build(BuildContext context) {
    return Listener(
      onPointerDown: _down,
      onPointerUp: _up,
      onPointerCancel: _up,
      child: AnimatedBuilder(
        animation: _scale,
        builder: (context, child) => Transform.scale(scale: _scale.value, child: child),
        child: widget.child,
      ),
    );
  }
}
