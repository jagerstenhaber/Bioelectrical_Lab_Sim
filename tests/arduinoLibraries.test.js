import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARDUINO_LIBRARY_REGISTRY,
  registerArduinoLibrary,
  resolveArduinoLibrary,
  getSupportedArduinoLibraries,
  findMissingLibraryInclude,
  applyLibraryTranspilers,
  createLibraryBindings
} from '../js/sim/arduinoLibraries.js';

import {
  ARDUINO_EXAMPLE_SKETCHES,
  transpileArduinoSketch,
  createArduinoRunner
} from '../js/sim/arduinoRuntime.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 1500, intervalMs = 10) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

test('1. Registry API resolves FIR.h, lists supported libraries, and allows modular extension', () => {
  assert.ok(ARDUINO_LIBRARY_REGISTRY instanceof Map);
  assert.ok(ARDUINO_LIBRARY_REGISTRY.has('FIR.h'));

  const firLib = resolveArduinoLibrary('FIR.h');
  assert.ok(firLib);
  assert.equal(firLib.header, 'FIR.h');
  assert.equal(resolveArduinoLibrary('FIR/FIR.h')?.header, 'FIR.h');
  assert.equal(resolveArduinoLibrary('fir_filter.h')?.header, 'FIR.h');
  assert.equal(resolveArduinoLibrary('NonExistentLib.h'), null);

  const supported = getSupportedArduinoLibraries();
  assert.ok(supported.some((lib) => lib.header === 'FIR.h'));

  // Verify custom library registration & cleanup
  const customHeader = 'TestCustomGain.h';
  try {
    registerArduinoLibrary({
      header: customHeader,
      aliases: ['CustomGainAlias.h'],
      name: 'Test Custom Gain',
      description: 'Unit test extensible library entry.',
      repoUrl: 'https://example.com/custom-gain',
      transpile: (code) => code.replace(/\bCUSTOM_FACTOR\b/g, '42'),
      createBindings: () => ({
        CustomGain: class {
          scale(x) {
            return x * 2;
          }
        }
      })
    });

    assert.equal(resolveArduinoLibrary(customHeader)?.header, customHeader);
    assert.equal(resolveArduinoLibrary('CustomGainAlias.h')?.header, customHeader);
    assert.equal(applyLibraryTranspilers('int v = CUSTOM_FACTOR;', [customHeader]), 'int v = 42;');

    const bindings = createLibraryBindings([customHeader]);
    const inst = new bindings.CustomGain();
    assert.equal(inst.scale(7), 14);
  } finally {
    ARDUINO_LIBRARY_REGISTRY.delete(customHeader);
  }
});

test('2. Official LeemanGeophysicalLLC moving_average.ino runs verbatim and aborts while (true) {}; cleanly', async () => {
  // Official moving_average.ino from LeemanGeophysicalLLC/FIR_Filter_Arduino_Library
  const movingAverageIno = `/*
  Moving average example from LeemanGeophysicalLLC/FIR_Filter_Arduino_Library
*/
#include <FIR.h>

// Make an instance of the FIR filter. We'll use at least a
// float type and 8 taps for the moving average.
FIR<float, 8> fir;

void setup() {
  Serial.begin(115200); // Start a serial port

  // Set the coefficients for an 8-tap moving average filter
  float coef[8] = { 1., 1., 1., 1., 1., 1., 1., 1.};
  fir.setFilterCoeffs(coef);

  // Set the gain
  Serial.print("Gain set: ");
  Serial.println(fir.getGain());
}

void loop() {
  for (float i = 0; i <= 15; i++)
  {
    Serial.print(i);
    Serial.print(" : ");
    Serial.println(fir.processReading(i));
  }
  while (true) {};
}
`;

  const compiled = transpileArduinoSketch(movingAverageIno);
  assert.equal(compiled.ok, true, compiled.error);
  assert.deepEqual(compiled.warnings, []);
  assert.deepEqual(compiled.includedHeaders, ['FIR.h']);

  const runner = createArduinoRunner({ clockScale: 10 });
  const startRes = runner.start(movingAverageIno);
  assert.equal(startRes.ok, true, startRes.error);

  const gotAllLines = await waitFor(() => runner.getState().serialLines.length >= 17);
  assert.equal(gotAllLines, true, `Got lines: ${JSON.stringify(runner.getState().serialLines)}`);

  // Let guarded `while (true) {};` run briefly, then verify fast clean stop
  await sleep(20);
  assert.equal(runner.getState().running, true);

  const stopStart = performance.now();
  runner.stop();
  const stopElapsedMs = performance.now() - stopStart;

  assert.equal(runner.getState().running, false);
  assert.ok(stopElapsedMs < 100, `Expected stop() in < 100 ms, took ${stopElapsedMs.toFixed(2)} ms`);

  const lines = runner.getState().serialLines;
  assert.equal(lines[0], 'Gain set: 8');

  // Verify exact moving average outputs for i = 0..15
  // Note: Serial.println(0) formats integer 0 as "0" (numerically 0.00).
  const expectedValues = [
    '0',
    '0.13',
    '0.38',
    '0.75',
    '1.25',
    '1.88',
    '2.63',
    '3.50',
    '4.50',
    '5.50',
    '6.50',
    '7.50',
    '8.50',
    '9.50',
    '10.50',
    '11.50'
  ];

  for (let idx = 0; idx < expectedValues.length; idx += 1) {
    assert.equal(lines[idx + 1], `${idx} : ${expectedValues[idx]}`);
  }
});

test('3. Official LeemanGeophysicalLLC multiple_filters.ino runs verbatim with multiline arrays and dual FIR instances', async () => {
  // Official multiple_filters.ino from LeemanGeophysicalLLC/FIR_Filter_Arduino_Library
  const multipleFiltersIno = `/*
  Multiple filters example from LeemanGeophysicalLLC/FIR_Filter_Arduino_Library
*/
#include <FIR.h>

FIR<float, 13> fir_lp;
FIR<float, 10> fir_avg;

void setup() {
  Serial.begin(115200);

  // 13-tap low-pass filter coefficients
  float coef_lp[13] = {-1391., -1647., -553., 2423., 6640., 10443., 11964.,
                        10443., 6640., 2423., -553., -1647., -1391.};
  fir_lp.setFilterCoeffs(coef_lp);

  // 10-tap moving average filter coefficients
  float coef_avg[10] = {1., 1., 1., 1., 1., 1., 1., 1., 1., 1.};
  fir_avg.setFilterCoeffs(coef_avg);

  Serial.print("Low Pass Gain: ");
  Serial.println(fir_lp.getGain());
  Serial.print("Moving Avg Gain: ");
  Serial.println(fir_avg.getGain());
}

void loop() {
  float data[51] = {
    0.2, 0.4, 0.6, 0.8, 1.0,
    1.2, 1.4, 1.6, 1.8, 2.0,
    1.8, 1.6, 1.4, 1.2, 1.0,
    0.8, 0.6, 0.4, 0.2, 0.0,
    -0.2, -0.4, -0.6, -0.8, -1.0,
    -1.2, -1.4, -1.6, -1.8, -2.0,
    -1.8, -1.6, -1.4, -1.2, -1.0,
    -0.8, -0.6, -0.4, -0.2, 0.0,
    0.2, 0.4, 0.6, 0.8, 1.0,
    1.2, 1.4, 1.6, 1.8, 2.0,
    2.2
  };

  for (int i = 0; i < 51; i++) {
    float lp = fir_lp.processReading(data[i]);
    float avg = fir_avg.processReading(data[i]);
    Serial.print(data[i]);
    Serial.print(",");
    Serial.print(lp);
    Serial.print(",");
    Serial.println(avg);
  }

  while (true) {};
}
`;

  const compiled = transpileArduinoSketch(multipleFiltersIno);
  assert.equal(compiled.ok, true, compiled.error);
  assert.deepEqual(compiled.warnings, []);

  const runner = createArduinoRunner({ clockScale: 10 });
  const startRes = runner.start(multipleFiltersIno);
  assert.equal(startRes.ok, true, startRes.error);

  const gotAllLines = await waitFor(() => runner.getState().serialLines.length >= 53);
  runner.stop();
  assert.equal(gotAllLines, true, `Got ${runner.getState().serialLines.length} lines`);

  const lines = runner.getState().serialLines;
  // Sum of coef_lp = 2*(-1391 - 1647 - 553 + 2423 + 6640 + 10443) + 11964 = 43794
  assert.equal(lines[0], 'Low Pass Gain: 43794');
  assert.equal(lines[1], 'Moving Avg Gain: 10');

  // Verify first data sample (0.2):
  // fir_lp: (-1391 * 0.2) / 43794 = -0.006352 -> -0.01
  // fir_avg: (1 * 0.2) / 10 = 0.02
  assert.equal(lines[2], '0.20,-0.01,0.02');

  // Verify sample index 9 (data[9] = 2.0):
  // fir_avg over [0.2..2.0] sum = 11.0 / 10 = 1.10
  const lineIdx9 = lines[2 + 9].split(',');
  assert.equal(lineIdx9[0], '2');
  assert.equal(lineIdx9[2], '1.10');

  // Verify final sample index 50 (data[50] = 2.2):
  // fir_avg over [0.4, 0.6, 0.8, 1.0, 1.2, 1.4, 1.6, 1.8, 2.0, 2.2] = 13.0 / 10 = 1.30
  const lastLineParts = lines[2 + 50].split(',');
  assert.equal(lastLineParts[0], '2.20');
  assert.equal(lastLineParts[2], '1.30');
  // Verify LP output at sample 50 (0.72) and peak smoothed LP output near index 15 (~1.81)
  const lpLast = Number(lastLineParts[1]);
  assert.equal(lastLineParts[1], '0.72');
  assert.ok(Number.isFinite(lpLast));
  const lpPeak = Math.max(...lines.slice(2, 53).map((l) => Number(l.split(',')[1])));
  assert.ok(lpPeak > 1.7 && lpPeak < 1.9, `Expected smoothed LP peak ~1.81, got ${lpPeak}`);
});

test('4. Integer template FIR<int, 4> and zero-sum high-pass coefficients with setGain(1.0)', async () => {
  const sketch = `
    #include <FIR.h>

    FIR<int, 4> fir_i, fir_hp;

    void setup() {
      Serial.begin(9600);

      // Integer moving average
      int coef_avg[4] = {1, 1, 1, 1};
      fir_i.setFilterCoeffs(coef_avg);
      Serial.println(fir_i.getGain());

      // Zero-sum high-pass filter -> auto gain is 0 until setGain(1.0)
      int coef_hp[4] = {1, -1, 1, -1};
      fir_hp.setFilterCoeffs(coef_hp);
      Serial.println(fir_hp.getGain());
      Serial.println(fir_hp.processReading(100)); // gain is 0 -> safely returns 0

      fir_hp.setGain(1.0);
      Serial.println(fir_hp.getGain());
    }

    void loop() {
      // Integer truncation check: (10 + 11 + 0 + 0) / 4 = 5
      Serial.println(fir_i.processReading(10));
      Serial.println(fir_i.processReading(11));
      Serial.println(fir_i.processReading(12));
      Serial.println(fir_i.processReading(13));

      // High-pass on constant DC 50 -> 50, 0, 50, 0
      Serial.println(fir_hp.processReading(50));
      Serial.println(fir_hp.processReading(50));
      Serial.println(fir_hp.processReading(50));
      Serial.println(fir_hp.processReading(50));
      while (true) {};
    }
  `;

  const runner = createArduinoRunner({ clockScale: 10 });
  const res = runner.start(sketch);
  assert.equal(res.ok, true, res.error);

  const done = await waitFor(() => runner.getState().serialLines.length >= 12);
  runner.stop();
  assert.equal(done, true);

  assert.deepEqual(runner.getState().serialLines.slice(0, 12), [
    '4',   // fir_i gain
    '0',   // fir_hp auto-calculated zero-sum gain
    '0',   // fir_hp safe output when gain === 0
    '1',   // fir_hp after setGain(1.0)
    '2',   // 10 / 4 -> trunc(2.5) = 2
    '5',   // (10 + 11) / 4 -> trunc(5.25) = 5
    '8',   // (10 + 11 + 12) / 4 -> trunc(8.25) = 8
    '11',  // (10 + 11 + 12 + 13) / 4 -> trunc(11.5) = 11
    '-50', // fir_hp ring buffer still holds 100 from setup(): 1*50 + (-1)*100 = -50
    '100', // 1*50 + 1*100 + (-1)*50 = 100
    '-50', // 1*50 + (-1)*100 + 1*50 + (-1)*50 = -50
    '0'    // steady-state DC [50, 50, 50, 50] -> 50 - 50 + 50 - 50 = 0
  ]);
});

test('5. Missing #include <FIR.h> emits clear compile error pointing to line and FIR template edge spaces work', async () => {
  const missingIncludeSketch = `void setup() {
  Serial.begin(9600);
}

FIR<float, 8> fir;

void loop() {}
`;

  const errRes = transpileArduinoSketch(missingIncludeSketch);
  assert.equal(errRes.ok, false);
  assert.match(errRes.error, /#include <FIR\.h>/);
  assert.equal(errRes.line, 5);

  // Verify spaced template syntax `FIR < float , 8 > myFir ;` compiles & runs
  const spacedSketch = `
    #include <FIR.h>
    FIR < float , 8 > myFir ;
    void setup() {
      Serial.begin(9600);
      float c[8] = {1, 1, 1, 1, 1, 1, 1, 1};
      myFir.setFilterCoeffs(c);
      Serial.println(myFir.getGain());
    }
    void loop() {
      Serial.println(myFir.processReading(8.0));
      while (true) {};
    }
  `;
  const runner = createArduinoRunner({ clockScale: 10 });
  const startRes = runner.start(spacedSketch);
  assert.equal(startRes.ok, true, startRes.error);

  const gotLines = await waitFor(() => runner.getState().serialLines.length >= 2);
  runner.stop();
  assert.equal(gotLines, true);
  assert.deepEqual(runner.getState().serialLines.slice(0, 2), ['8', '1']);
});

test('6. Built-in FIR example sketches compile and stream expected Serial Plotter channels', async () => {
  const firExampleIds = ['fir-moving-average', 'fir-emg-filter'];
  for (const id of firExampleIds) {
    const sketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === id);
    assert.ok(sketch, `Missing example sketch ${id}`);

    const runner = createArduinoRunner({
      clockScale: 20,
      readPinVoltage(pinId) {
        return pinId === 'A0' ? 2.5 : 0;
      }
    });

    const res = runner.start(sketch.code);
    assert.equal(res.ok, true, res.error);
    assert.deepEqual(res.warnings, []);

    const gotPlot = await waitFor(() => runner.getState().plotterSeries.length >= 2);
    runner.stop();
    assert.equal(gotPlot, true, `Expected plotter data for ${id}`);
  }
});

test('7. Double-quoted #include "FIR.h" compiles and runs identically to #include <FIR.h>, and unknown quoted headers warn', async () => {
  const quotedSketch = `
    #include "FIR.h"

    FIR<float, 4> fir;

    void setup() {
      Serial.begin(9600);
      float c[4] = {1.0, 1.0, 1.0, 1.0};
      fir.setFilterCoeffs(c);
      Serial.println(fir.getGain());
    }

    void loop() {
      Serial.println(fir.processReading(8.0));
      while (true) {};
    }
  `;

  const compiled = transpileArduinoSketch(quotedSketch);
  assert.equal(compiled.ok, true, compiled.error);
  assert.deepEqual(compiled.warnings, []);
  assert.deepEqual(compiled.includedHeaders, ['FIR.h']);

  const runner = createArduinoRunner({ clockScale: 10 });
  const res = runner.start(quotedSketch);
  assert.equal(res.ok, true, res.error);

  const done = await waitFor(() => runner.getState().serialLines.length >= 2);
  runner.stop();
  assert.equal(done, true);
  assert.deepEqual(runner.getState().serialLines.slice(0, 2), ['4', '2']);

  const unknownQuoted = transpileArduinoSketch(`
    #include "UnknownCustomLib.h"
    void setup() {}
    void loop() {}
  `);
  assert.equal(unknownQuoted.ok, true, unknownQuoted.error);
  assert.equal(unknownQuoted.warnings.length, 1);
  assert.match(unknownQuoted.warnings[0], /UnknownCustomLib\.h/);
});

test('8. Float high-pass coefficients snap near-zero DC gain to 0 (no 1e16 explosion) and work after setGain(1.0)', async () => {
  const hpSketch = `
    #include <FIR.h>

    FIR<float, 5> fir;

    void setup() {
      Serial.begin(9600);
      float hp[5] = {-0.1, -0.2, 0.6, -0.2, -0.1};
      fir.setFilterCoeffs(hp);
      Serial.println(fir.getGain());
      Serial.println(fir.processReading(10.0));

      fir.setGain(1.0);
      Serial.println(fir.getGain());
    }

    void loop() {
      Serial.println(fir.processReading(10.0));
      Serial.println(fir.processReading(10.0));
      Serial.println(fir.processReading(10.0));
      Serial.println(fir.processReading(10.0));
      Serial.println(fir.processReading(10.0));
      while (true) {};
    }
  `;

  const runner = createArduinoRunner({ clockScale: 10 });
  const res = runner.start(hpSketch);
  assert.equal(res.ok, true, res.error);

  const done = await waitFor(() => runner.getState().serialLines.length >= 8);
  runner.stop();
  assert.equal(done, true);

  assert.deepEqual(runner.getState().serialLines.slice(0, 8), [
    '0',     // (-0.1 - 0.2 + 0.6 - 0.2 - 0.1) = -2.7755e-17 snapped cleanly to 0
    '0',     // processReading returns 0 safely when gain === 0
    '1',     // after fir.setGain(1.0)
    '-2',    // _k=1: coeffs[0]*v[1] + coeffs[4]*v[0] = (-0.1 - 0.1)*10 = -2
    '-4',    // _k=2: (-0.1 - 0.2 - 0.1)*10 = -4
    '2',     // _k=3: (-0.1 + 0.6 - 0.2 - 0.1)*10 = 2
    '0',     // steady state DC: (-0.1 - 0.2 + 0.6 - 0.2 - 0.1)*10 = 0
    '0'      // steady state DC: 0
  ]);

  // Also check static FIR<float, 4> inside loop() persists across iterations and findMissingLibraryInclude
  const staticFirSketch = `
    #include <FIR.h>
    void setup() {
      Serial.begin(9600);
    }
    void loop() {
      static FIR<float, 4> localFir;
      static int initDone = 0;
      if (!initDone) {
        float c[4] = {1.0, 1.0, 1.0, 1.0};
        localFir.setFilterCoeffs(c);
        initDone = 1;
      }
      Serial.println(localFir.processReading(4.0));
      delay(10);
    }
  `;
  const staticRunner = createArduinoRunner({ clockScale: 20 });
  const staticRes = staticRunner.start(staticFirSketch);
  assert.equal(staticRes.ok, true, staticRes.error);
  const gotStatic = await waitFor(() => staticRunner.getState().serialLines.length >= 3);
  staticRunner.stop();
  assert.equal(gotStatic, true);
  assert.deepEqual(staticRunner.getState().serialLines.slice(0, 3), ['1', '2', '3']);

  assert.equal(findMissingLibraryInclude('FIR<float, 8> f;', [])?.header, 'FIR.h');
  assert.equal(findMissingLibraryInclude('FIR<float, 8> f;', ['FIR.h']), null);
});

test('9. runner.getElapsedMs() returns live elapsed virtual ms without cloning full state', async () => {
  const sketch = `
    void setup() {
      Serial.begin(9600);
    }
    void loop() {
      Serial.println("tick");
      delay(20);
    }
  `;

  const runner = createArduinoRunner({ clockScale: 5 });
  assert.equal(runner.getElapsedMs(), 0);

  const res = runner.start(sketch);
  assert.equal(res.ok, true, res.error);

  await sleep(30);
  const t1 = runner.getElapsedMs();
  assert.ok(typeof t1 === 'number' && Number.isFinite(t1) && t1 > 0, `Expected t1 > 0, got ${t1}`);

  await sleep(25);
  const t2 = runner.getElapsedMs();
  assert.ok(t2 > t1, `Expected t2 (${t2}) > t1 (${t1})`);

  runner.stop();
  const stoppedMs = runner.getElapsedMs();
  await sleep(20);
  assert.equal(runner.getElapsedMs(), stoppedMs);
});

