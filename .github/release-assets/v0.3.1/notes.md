Automata v0.3.1 is a preview for Windows and Android.

- Fix the extra Windows console opened by the Codex npm launcher.
- Show actual chat states: queued, responding, answered, failed and interrupted.
- Publish each agent's response as soon as its turn finishes.
- Support local folders without requiring Git, plus optional GitHub sign-in and repository import.
- Connect Claude Code and Codex/ChatGPT through their official sign-in flows.

Windows: download `Automata-0.3.1-Windows-x64.zip`, extract the complete folder, and run `Automata.exe`. Keep its supporting files together. Install Claude Code and Codex CLI separately, then connect your accounts inside Automata.

Android: install `Automata-0.3.1-Android.apk` and connect it to the coordinator running on your PC. The APK is the exact existing development-signed build; its signing identity has been preserved. Android requires the PC to remain running.

This preview contains an unsigned Windows application and a development-signed APK. Windows compatibility mode is identified in the app when active. Model availability depends on your accounts. The real-provider end-to-end coding cycle and GitHub network import still need validation; demo and simulated-provider checks do not certify unattended work.

Validation: 34 core tests, 7 chat UI checks, a packaged EXE demo/chat cycle, and a real Windows comparison showing 12 visible consoles before the fix and zero after it. No model credits were used for these checks.

App source: commit `441ab4bd910d84b59a7d65ca74d45521148611c6`. `release-manifest.json` records build provenance; `SHA256SUMS.txt` verifies the download files.
