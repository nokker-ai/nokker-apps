# public/knock — knock to call (browser)

Served as-is, same origin. Origin of each file:

| File | Origin | Licence |
|---|---|---|
| `knock.js`, `knock-worklet.js` | Browser module of the Nokker core (`web/knock/`), copied unchanged | same as this repository |
| `cnn.json` | Network weights, trained on the FSD50K clips listed in `cnn-ATTRIBUTION.csv` | weights: ours; clips: CC0 1.0 or CC BY 3.0 (see the list); FSD50K annotations CC BY 4.0 |
| `triple.json` | Triplet judge, trained on the FSD50K clips listed in `triple-ATTRIBUTION.csv` | same as above |
| `../sounds/nokker-yes.wav` | The “yes?” answer: a synthetic chime, generated (no recording, no speech synthesis) | our work, dedicated to the public domain (CC0 1.0) |

`nokker-yes.wav`: 22 050 Hz, mono, 16 bit, 0.51 s, written with Python's `wave` module. Two rising tones, each with
its octave at a quarter of the amplitude (`sin(φ) + 0.25·sin(2φ)`), envelope 8 ms attack then `exp(-7t)`, amplitude
0.35: 587→600 Hz for 0.16 s, 0.03 s of silence, then 784→880 Hz for 0.32 s (linear glide within each tone).
