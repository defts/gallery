import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/gallery/motion/pressable.dart';

double _scaleOf(WidgetTester tester) {
  final transform = tester.widget<Transform>(
    find.descendant(of: find.byType(GalleryPressable), matching: find.byType(Transform)),
  );
  return transform.transform.storage[0];
}

Widget _host({required VoidCallback onTap, bool reduceMotion = false}) => MaterialApp(
  home: MediaQuery(
    data: MediaQueryData(disableAnimations: reduceMotion),
    child: Center(
      child: GalleryPressable(
        pressedScale: 0.9,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: onTap,
          child: const SizedBox(key: Key('target'), width: 60, height: 60),
        ),
      ),
    ),
  ),
);

void main() {
  testWidgets('squishes while held and springs back after release', (tester) async {
    await tester.pumpWidget(_host(onTap: () {}));
    expect(_scaleOf(tester), 1.0);

    final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('target'))));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 200));
    expect(_scaleOf(tester), closeTo(0.9, 0.001));

    await gesture.up();
    await tester.pumpAndSettle();
    expect(_scaleOf(tester), closeTo(1.0, 0.001));
  });

  testWidgets('a quick tap still dips before springing back', (tester) async {
    await tester.pumpWidget(_host(onTap: () {}));
    final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('target'))));
    await gesture.up();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 45));
    expect(_scaleOf(tester), lessThan(0.97));
    await tester.pumpAndSettle();
    expect(_scaleOf(tester), closeTo(1.0, 0.001));
  });

  testWidgets('the child still gets the tap', (tester) async {
    var taps = 0;
    await tester.pumpWidget(_host(onTap: () => taps++));
    await tester.tap(find.byKey(const Key('target')));
    await tester.pumpAndSettle();
    expect(taps, 1);
  });

  testWidgets('does not move when the OS asks for reduced motion', (tester) async {
    await tester.pumpWidget(_host(onTap: () {}, reduceMotion: true));
    final gesture = await tester.startGesture(tester.getCenter(find.byKey(const Key('target'))));
    await tester.pump(const Duration(milliseconds: 200));
    expect(_scaleOf(tester), 1.0);
    await gesture.up();
  });
}
