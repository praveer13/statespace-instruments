# Third-party software served from this origin

The course's own files here (`index.html`, `sw.js`, and each build's `host.html`, `host.js`, `worker.mjs`, `cases.mjs` and `manifest.json`) are under the MIT License in `LICENSE`, like the code in the main repository. Each build under `b/` also serves unmodified engine files from the projects below, which keep their own licenses.

| Path under `b/<build>/engines/` | Component | Version | License | Source |
|---|---|---|---|---|
| `pyodide/314.0.7/` | [Pyodide](https://github.com/pyodide/pyodide): `pyodide.mjs`, `pyodide.asm.mjs`, `pyodide.asm.wasm`, `pyodide-lock.json` | 314.0.7, the npm package `pyodide@314.0.7` | MPL-2.0 ([text](LICENSES/MPL-2.0.txt)) | the Source Code Form is Pyodide's repository at its 314.0.7 release; `pyodide.asm.wasm` also contains CPython and the libraries Pyodide builds into it, whose licenses Pyodide's repository lists at that release |
| `pyodide/314.0.7/python_stdlib.zip` | CPython's standard library, as packaged by Pyodide | Python 3.14 | PSF License ([text](LICENSES/Python-2.0.txt)) | [python/cpython](https://github.com/python/cpython), branch 3.14 |
| `z3/5.3.1.0/` | [Z3](https://github.com/Z3Prover/z3) as the `z3-solver` wheel for Pyodide | 5.3.1.0 | MIT, Copyright (c) Microsoft Corporation ([text](LICENSES/Z3-MIT.txt)) | the wheel's metadata names `https://github.com/Z3Prover/z3` |

The files are served exactly as the packages ship them. The license texts under `LICENSES/` were fetched on 2026-10-25 from mozilla.org (MPL-2.0), the CPython 3.14 branch (`LICENSE`) and the Z3 repository (`LICENSE.txt`).
