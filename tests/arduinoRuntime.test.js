import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ARDUINO_NANO_PWM_PINS,
  ARDUINO_NANO_ANALOG_ONLY_PINS,
  ARDUINO_EXAMPLE_SKETCHES,
  normalizeArduinoPinId,
  parseSerialPlotterLine,
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

test('1. Constants and normalizeArduinoPinId map all valid/invalid Arduino Nano pins', () => {
  assert.deepEqual([...ARDUINO_NANO_PWM_PINS], ['D3', 'D5', 'D6', 'D9', 'D10', 'D11']);
  assert.deepEqual([...ARDUINO_NANO_ANALOG_ONLY_PINS], ['A6', 'A7']);

  // Digital 0..13
  for (let i = 0; i <= 13; i += 1) {
    assert.equal(normalizeArduinoPinId(i), `D${i}`);
    assert.equal(normalizeArduinoPinId(`D${i}`), `D${i}`);
    assert.equal(normalizeArduinoPinId(`d${i}`), `D${i}`);
  }

  // Analog 14..21 and A0..A7
  for (let i = 0; i <= 7; i += 1) {
    assert.equal(normalizeArduinoPinId(14 + i), `A${i}`);
    assert.equal(normalizeArduinoPinId(`A${i}`), `A${i}`);
    assert.equal(normalizeArduinoPinId(`a${i}`), `A${i}`);
  }

  // Whitespace & numeric strings
  assert.equal(normalizeArduinoPinId(' 9 '), 'D9');
  assert.equal(normalizeArduinoPinId(' 14 '), 'A0');

  // Invalid pins
  for (const invalid of [-1, 22, 1.5, NaN, Infinity, null, undefined, true, false, '', 'D14', 'A8', 'VCC', 'GND']) {
    assert.equal(normalizeArduinoPinId(invalid), null, `Expected null for ${String(invalid)}`);
  }
});

test('2. parseSerialPlotterLine handles unlabeled, CSV, tab/space, labeled, and prose lines', () => {
  assert.deepEqual(parseSerialPlotterLine('512'), [{ label: 'CH1', value: 512 }]);

  assert.deepEqual(parseSerialPlotterLine('512, 2.50'), [
    { label: 'CH1', value: 512 },
    { label: 'CH2', value: 2.5 }
  ]);

  assert.deepEqual(parseSerialPlotterLine('100\t200\t300'), [
    { label: 'CH1', value: 100 },
    { label: 'CH2', value: 200 },
    { label: 'CH3', value: 300 }
  ]);

  assert.deepEqual(parseSerialPlotterLine('10 20 -3.5'), [
    { label: 'CH1', value: 10 },
    { label: 'CH2', value: 20 },
    { label: 'CH3', value: -3.5 }
  ]);

  assert.deepEqual(parseSerialPlotterLine('ADC:512, Volts:2.50'), [
    { label: 'ADC', value: 512 },
    { label: 'Volts', value: 2.5 }
  ]);

  assert.deepEqual(parseSerialPlotterLine('EMG=1.24\tThresh=0.80'), [
    { label: 'EMG', value: 1.24 },
    { label: 'Thresh', value: 0.8 }
  ]);

  assert.equal(parseSerialPlotterLine('Ready!'), null);
  assert.equal(parseSerialPlotterLine('LED: ON'), null);
  assert.equal(parseSerialPlotterLine('   '), null);
  assert.equal(parseSerialPlotterLine(null), null);
});

test('3. transpileArduinoSketch compiles all 8 built-in example sketches cleanly', () => {
  assert.equal(ARDUINO_EXAMPLE_SKETCHES.length, 8);

  const expectedIds = [
    'blink',
    'button-led',
    'pot-plotter',
    'threshold-alarm',
    'serial-echo',
    'fir-moving-average',
    'fir-emg-filter',
    'ppg-ldr-plotter'
  ];
  assert.deepEqual(
    ARDUINO_EXAMPLE_SKETCHES.map((s) => s.id),
    expectedIds
  );

  for (const sketch of ARDUINO_EXAMPLE_SKETCHES) {
    const res = transpileArduinoSketch(sketch.code);
    assert.equal(res.ok, true, `Sketch ${sketch.id} failed to compile: ${res.error || ''}`);
    assert.equal(Array.isArray(res.warnings), true);
    assert.match(res.jsCode, /async function setup\(/);
    assert.match(res.jsCode, /async function loop\(/);
  }
});

test('4. transpileArduinoSketch handles C++ features, string protection, and reports clear errors', () => {
  const sketch = `
    #include <Arduino.h>
    #include <Servo.h>
    #define GAIN 2.5f
    #define LED_PIN 13

    int samples[4] = {10, 20, 30, 40};
    int scratch[3];

    // Helper function containing delay()
    float readScaled(int raw) {
      delay(5);
      return (float)raw * GAIN;
    }

    void setup() {
      pinMode(LED_PIN, OUTPUT);
      Serial.begin(9600);
      // String with // and C++ keywords must remain untouched
      String msg = "// int fake = 123; /* not a comment */";
      Serial.println(msg);
      for (int i = 0; i < 4; i++) {
        scratch[0] = (int)readScaled(samples[i]);
      }
    }

    void loop() {
      float v = 5.0f;
      int truncated = (int)v;
      delay(10);
    }
  `;

  const res = transpileArduinoSketch(sketch);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.warnings.length, 1);
  assert.match(res.warnings[0], /Servo\.h/);
  assert.match(res.jsCode, /let samples = \[10, 20, 30, 40\];/);
  assert.match(res.jsCode, /let scratch = new Array\(3\)\.fill\(0\);/);
  assert.match(res.jsCode, /async function readScaled\(raw\)/);
  assert.match(res.jsCode, /\(await readScaled\(samples\[i\]\)\)/);
  assert.match(res.jsCode, /let msg = "\/\/ int fake = 123; \/\* not a comment \*\/";/);
  assert.match(res.jsCode, /for \(let i = 0;/);
  assert.match(res.jsCode, /await __guard\(\);/);

  // Missing loop()
  const missingLoop = transpileArduinoSketch('void setup() {}');
  assert.equal(missingLoop.ok, false);
  assert.match(missingLoop.error, /loop/);

  // Unclosed brace with line number
  const badBrace = transpileArduinoSketch('void setup() {\n  int x = 1;\n\nvoid loop() {}');
  assert.equal(badBrace.ok, false);
  assert.equal(typeof badBrace.line, 'number');
  assert.ok(badBrace.line >= 1);

  // Syntax error inside loop()
  const syntaxErr = transpileArduinoSketch('void setup() {}\nvoid loop() {\n  int x = ;\n}');
  assert.equal(syntaxErr.ok, false);
  assert.match(syntaxErr.error, /Compile error/);
  assert.equal(syntaxErr.line, 3);
});

test('5. Live Blink execution toggles D13 (5 V -> 0 V), updates ledBuiltIn, and logs Serial', async () => {
  const blink = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === 'blink');
  const d13Voltages = [];
  const serialOut = [];

  const runner = createArduinoRunner({
    clockScale: 20, // 500 ms virtual delay -> 25 ms real time
    onPinStateChange(pinId, state) {
      if (pinId === 'D13' && state.mode === 'OUTPUT') {
        d13Voltages.push(state.voltage);
      }
    },
    onSerialOutput(line) {
      serialOut.push(line);
    }
  });

  const startRes = runner.start(blink.code);
  assert.equal(startRes.ok, true);

  const toggled = await waitFor(
    () => d13Voltages.includes(5) && d13Voltages.includes(0) && serialOut.includes('LED: OFF'),
    1500,
    5
  );
  runner.stop();

  assert.equal(toggled, true, `Expected D13 toggle and Serial logs; got V=${d13Voltages}, serial=${serialOut}`);
  assert.ok(serialOut.includes('Blink ready on D13'));
  assert.ok(serialOut.includes('LED: ON'));

  // Verify ledBuiltIn tracks D13 state cleanly during execution
  const ledCheckRunner = createArduinoRunner({ clockScale: 20 });
  ledCheckRunner.start(`
    void setup() { pinMode(LED_BUILTIN, OUTPUT); }
    void loop() { digitalWrite(LED_BUILTIN, HIGH); delay(200); }
  `);
  const lit = await waitFor(() => ledCheckRunner.getState().ledBuiltIn === true, 1000, 5);
  ledCheckRunner.stop();
  assert.equal(lit, true);
  assert.equal(ledCheckRunner.getState().running, false);
});

test('6. Live Potentiometer analogRead(A0) -> analogWrite(9, pwm) + Serial Plotter parsing', async () => {
  const potSketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === 'pot-plotter');
  const runner = createArduinoRunner({
    clockScale: 10,
    readPinVoltage(pinId) {
      return pinId === 'A0' ? 2.5 : 0;
    }
  });

  const res = runner.start(potSketch.code);
  assert.equal(res.ok, true);

  const ready = await waitFor(() => {
    const st = runner.getState();
    return st.pinStates.D9.mode === 'PWM' && st.plotterSeries.length >= 1;
  });
  const state = runner.getState();
  runner.stop();

  assert.equal(ready, true);
  assert.equal(state.pinStates.D9.mode, 'PWM');
  assert.equal(state.pinStates.D9.dutyCycle, 127); // 2.5 V -> 512 ADC -> Math.trunc(512 * 255 / 1023) = 127 PWM
  assert.equal(state.pinStates.D9.freqHz, 490);

  const firstPlot = state.plotterSeries[0];
  assert.equal(firstPlot.channels[0].label, 'ADC');
  assert.equal(firstPlot.channels[0].value, 512);
  assert.equal(firstPlot.channels[1].label, 'PWM');
  assert.equal(firstPlot.channels[1].value, 127);
});

test('7. Live INPUT_PULLUP + digitalRead(2) and Serial.readStringUntil interactive command echo', async () => {
  // 7a: Button sketch with INPUT_PULLUP
  const buttonSketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === 'button-led');
  let buttonPressed = false;
  const buttonRunner = createArduinoRunner({
    clockScale: 10,
    readPinVoltage(pinId, pinState) {
      if (pinId === 'D2') {
        if (buttonPressed) return 0;
        return pinState?.mode === 'INPUT_PULLUP' ? 5 : 0;
      }
      return 0;
    }
  });

  buttonRunner.start(buttonSketch.code);
  const sawIdle = await waitFor(
    () =>
      buttonRunner.getState().pinStates.D2.mode === 'INPUT_PULLUP' &&
      buttonRunner.getState().pinStates.D9.voltage === 0 &&
      buttonRunner.getState().serialLines.includes('Button + LED ready')
  );
  assert.equal(sawIdle, true);

  buttonPressed = true;
  const sawPress = await waitFor(
    () =>
      buttonRunner.getState().pinStates.D9.voltage === 5 &&
      buttonRunner.getState().serialLines.includes('Button pressed')
  );
  buttonRunner.stop();
  assert.equal(sawPress, true);

  // 7b: Interactive Serial command echo
  const serialSketch = ARDUINO_EXAMPLE_SKETCHES.find((s) => s.id === 'serial-echo');
  const serialRunner = createArduinoRunner({ clockScale: 10 });
  serialRunner.start(serialSketch.code);

  const booted = await waitFor(() =>
    serialRunner.getState().serialLines.includes('Send ON, OFF, or 0..255')
  );
  assert.equal(booted, true);

  serialRunner.sendSerialInput('ON\n');
  const turnedOn = await waitFor(
    () =>
      serialRunner.getState().pinStates.D9.dutyCycle === 255 &&
      serialRunner.getState().pinStates.D13.voltage === 5 &&
      serialRunner.getState().serialLines.includes('LED ON (255)')
  );
  assert.equal(turnedOn, true);

  serialRunner.sendSerialInput('120\n');
  const dimmed = await waitFor(
    () =>
      serialRunner.getState().pinStates.D9.dutyCycle === 120 &&
      serialRunner.getState().serialLines.includes('PWM set to 120')
  );
  assert.equal(dimmed, true);

  serialRunner.sendSerialInput('OFF\n');
  const turnedOff = await waitFor(
    () =>
      serialRunner.getState().pinStates.D9.dutyCycle === 0 &&
      serialRunner.getState().pinStates.D13.voltage === 0 &&
      serialRunner.getState().serialLines.includes('LED OFF (0)')
  );
  serialRunner.stop();
  assert.equal(turnedOff, true);
});

test('8. Safety: infinite while (true) {} inside loop() does not hang and stops in < 100 ms', async () => {
  const infiniteSketch = `
    void setup() {
      pinMode(13, OUTPUT);
    }
    void loop() {
      digitalWrite(13, HIGH);
      while (true) {}
    }
  `;

  const runner = createArduinoRunner();
  const res = runner.start(infiniteSketch);
  assert.equal(res.ok, true);

  const enteredLoop = await waitFor(() => runner.getState().pinStates.D13.voltage === 5, 500, 5);
  assert.equal(enteredLoop, true);

  // Let the guarded infinite loop spin across multiple event-loop turns
  await sleep(25);
  assert.equal(runner.getState().running, true);

  const stopStart = performance.now();
  runner.stop();
  const stopElapsedMs = performance.now() - stopStart;

  assert.equal(runner.getState().running, false);
  assert.ok(stopElapsedMs < 100, `Expected stop() in < 100 ms, took ${stopElapsedMs.toFixed(2)} ms`);
});

test('9. Sandbox blocks access to window/document/fetch/globalThis and handles reset()', async () => {
  for (const forbidden of ['window', 'document', 'fetch', 'globalThis']) {
    const blocked = transpileArduinoSketch(`
      void setup() { Serial.println(typeof ${forbidden}); }
      void loop() {}
    `);
    assert.equal(blocked.ok, false, `Expected ${forbidden} to be blocked`);
  }

  const sandboxProbe = `
    void setup() {
      Serial.begin(9600);
      Serial.println(typeof navigator);
      Serial.println(typeof location);
      Serial.println(typeof setTimeout);
      Serial.println(typeof Proxy);
    }
    void loop() {
      delay(50);
    }
  `;

  const runner = createArduinoRunner({ clockScale: 10 });
  const res = runner.start(sandboxProbe);
  assert.equal(res.ok, true);

  const gotLines = await waitFor(() => runner.getState().serialLines.length >= 4);
  assert.equal(gotLines, true);
  assert.deepEqual(runner.getState().serialLines.slice(0, 4), [
    'undefined',
    'undefined',
    'undefined',
    'undefined'
  ]);

  runner.reset();
  const resetState = runner.getState();
  assert.equal(resetState.running, false);
  assert.equal(resetState.serialLines.length, 0);
  assert.equal(resetState.plotterSeries.length, 0);
  assert.equal(resetState.pinStates.D13.mode, 'INPUT');
});

test('10. Sandbox rejects escape identifiers with exact 1-based line number', () => {
  const cases = [
    {
      label: 'top.document',
      code: 'void setup() {}\nvoid loop() {\n  Serial.println(top.document);\n}',
      expectedKeyword: 'top',
      expectedLine: 3
    },
    {
      label: 'constructor chain',
      code: 'void setup() {\n  "".constructor.constructor("return window")();\n}\nvoid loop() {}',
      expectedKeyword: 'constructor',
      expectedLine: 2
    },
    {
      label: 'eval call',
      code: 'void setup() {}\nvoid loop() {\n  int x = 0;\n  eval("1");\n}',
      expectedKeyword: 'eval',
      expectedLine: 4
    },
    {
      label: 'dynamic import',
      code: 'void setup() {\n  import("x");\n}\nvoid loop() {}',
      expectedKeyword: 'import',
      expectedLine: 2
    }
  ];

  for (const tc of cases) {
    const res = transpileArduinoSketch(tc.code);
    assert.equal(res.ok, false, `Expected ${tc.label} to be rejected`);
    assert.equal(res.line, tc.expectedLine, `Expected line ${tc.expectedLine} for ${tc.label}, got ${res.line}`);
    assert.match(res.error, new RegExp(`Restricted keyword "${tc.expectedKeyword}"`), tc.label);
  }

  // String literals containing forbidden words should still be allowed
  const safeString = transpileArduinoSketch(`
    void setup() { Serial.println("window document constructor eval import"); }
    void loop() {}
  `);
  assert.equal(safeString.ok, true, safeString.error);
});

test('11. Safety: braceless infinite while/for/do-while loops abort cleanly in < 100 ms', async () => {
  const bracelessWhile = `
    int count = 0;
    void setup() {
      pinMode(13, OUTPUT);
    }
    void loop() {
      digitalWrite(13, HIGH);
      while (true) count++;
    }
  `;

  const runner = createArduinoRunner();
  const res = runner.start(bracelessWhile);
  assert.equal(res.ok, true, res.error);

  const enteredLoop = await waitFor(() => runner.getState().pinStates.D13.voltage === 5, 500, 5);
  assert.equal(enteredLoop, true);

  await sleep(25);
  assert.equal(runner.getState().running, true);

  const stopStart = performance.now();
  runner.stop();
  const stopElapsedMs = performance.now() - stopStart;

  assert.equal(runner.getState().running, false);
  assert.ok(stopElapsedMs < 100, `Expected stop() in < 100 ms, took ${stopElapsedMs.toFixed(2)} ms`);

  // Also check braceless for & do-while transpile with __guard()
  const multiBraceless = transpileArduinoSketch(`
    void setup() {
      int sum = 0;
      for (int i = 0; i < 5; i++)
        if (i % 2 == 0) sum += i;
        else sum += 1;
      do sum++; while (sum < 10);
    }
    void loop() {}
  `);
  assert.equal(multiBraceless.ok, true, multiBraceless.error);
  const guardCount = (multiBraceless.jsCode.match(/await __guard\(\);/g) || []).length;
  assert.equal(guardCount, 2);
});

test('12. clearSerial() and clearPlotter() reset buffers and bump versions after > 520 lines/points', async () => {
  const floodSketch = `
    int n = 0;
    void setup() {
      Serial.begin(9600);
      for (int i = 0; i < 530; i++) {
        Serial.println(i);
        n++;
      }
    }
    void loop() {
      n++;
      Serial.println(n);
      delay(15);
    }
  `;

  const runner = createArduinoRunner({ clockScale: 10 });
  const res = runner.start(floodSketch);
  assert.equal(res.ok, true, res.error);

  const flooded = await waitFor(
    () =>
      runner.getState().serialLines.length === 500 &&
      runner.getState().plotterSeries.length === 500 &&
      runner.getState().serialVersion >= 530 &&
      runner.getState().plotterVersion >= 530
  );
  assert.equal(flooded, true);

  const beforeClear = runner.getState();
  runner.clearSerial();
  const afterClearSerial = runner.getState();
  assert.equal(afterClearSerial.serialLines.length, 0);
  assert.ok(afterClearSerial.serialVersion > beforeClear.serialVersion);

  runner.clearPlotter();
  const afterClearPlotter = runner.getState();
  assert.equal(afterClearPlotter.plotterSeries.length, 0);
  assert.ok(afterClearPlotter.plotterVersion > afterClearSerial.plotterVersion);

  // New lines and points should appear immediately after clear
  const refilled = await waitFor(
    () =>
      runner.getState().serialLines.length >= 1 &&
      runner.getState().plotterSeries.length >= 1
  );
  runner.stop();
  assert.equal(refilled, true);
  assert.ok(Number(runner.getState().serialLines[0]) >= 530);
});

test('13. C++ fidelity & perf: static local persistence, BIN/OCT/DEC/HEX, multi-var init, casts, and pin diffing', async () => {
  let d13ChangeCount = 0;
  const runner = createArduinoRunner({
    clockScale: 20,
    onPinStateChange(pinId) {
      if (pinId === 'D13') {
        d13ChangeCount += 1;
      }
    }
  });

  const sketch = `
    void setup() {
      Serial.begin(9600);
      pinMode(13, OUTPUT);
      pinMode(13, OUTPUT); // unchanged, should not emit duplicate pin change

      Serial.println(10, BIN);
      Serial.println(42, DEC);
      Serial.println(255, HEX);
      Serial.println(9, OCT);
      Serial.println(5.123, 2);

      int a, b;
      b++;
      Serial.println(b);

      int c = 5, d;
      Serial.println(d);

      String greeting("hi");
      int initCount(7);
      Serial.println(greeting);
      Serial.println(initCount);

      int arr[3] = {4, 5, 6};
      int idx = 1;
      float f1 = (float)5;
      int neg = (int)-f1;
      int elem = (int)arr[idx];
      float f2 = float(3);
      int i2 = int(3.9);
      Serial.println(neg);
      Serial.println(elem);
      Serial.println(f2, 1);
      Serial.println(i2);
    }

    void loop() {
      static int count = 0;
      count++;
      Serial.print("iter:");
      Serial.println(count);

      digitalWrite(13, HIGH); // 1st change
      digitalWrite(13, HIGH); // unchanged -> should NOT emit onPinStateChange
      delay(20);
    }
  `;

  const res = runner.start(sketch);
  assert.equal(res.ok, true, res.error);

  const done = await waitFor(() =>
    runner.getState().serialLines.includes('iter:3')
  );
  runner.stop();
  assert.equal(done, true);

  const lines = runner.getState().serialLines;
  assert.equal(lines[0], '1010'); // 10 in BIN
  assert.equal(lines[1], '42');   // 42 in DEC
  assert.equal(lines[2], 'FF');   // 255 in HEX
  assert.equal(lines[3], '11');   // 9 in OCT
  assert.equal(lines[4], '5.12'); // 5.123 with 2 decimals
  assert.equal(lines[5], '1');    // int a, b; b++ -> 1 (not NaN)
  assert.equal(lines[6], '0');    // int c = 5, d; -> 0 (not undefined)
  assert.equal(lines[7], 'hi');   // String greeting("hi");
  assert.equal(lines[8], '7');    // int initCount(7);
  assert.equal(lines[9], '-5');   // (int)-f1
  assert.equal(lines[10], '5');   // (int)arr[idx]
  assert.equal(lines[11], '3.0'); // float(3)
  assert.equal(lines[12], '3');   // int(3.9)
  assert.ok(lines.includes('iter:1'));
  assert.ok(lines.includes('iter:2'));
  assert.ok(lines.includes('iter:3'));

  // pinMode(13, OUTPUT) from initial INPUT -> 1 change; second pinMode(13, OUTPUT) -> 0;
  // 1st digitalWrite(13, HIGH) -> 1 change; subsequent digitalWrite(13, HIGH) calls -> 0
  assert.equal(d13ChangeCount, 2, `Expected exactly 2 D13 pin changes, got ${d13ChangeCount}`);
});
