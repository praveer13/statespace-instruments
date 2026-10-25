# statespace-instruments

The instrument origin for [statespace](https://github.com/praveer13/statespace), served at `statespace-instruments.play.naigap.com`.

The course keeps its main site and its instruments on separate origins: untrusted input (specs in URL fragments, imported receipts, learner-built wasm) is parsed only on this origin, and the two talk through a message-only bus (spine invariant I6, owner decision OD-5, `docs/ARCHITECTURE.md`). This repository holds only what is deployed here; the instruments are built in the main repository.

## License

The course's own files here are under the MIT License (`LICENSE`). The engine files each build serves keep their own licenses; `THIRD-PARTY.md` lists them with their sources and license texts.
