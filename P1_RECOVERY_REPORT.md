# P1 · Recuperación autónoma y resistencia a errores: reporte

Fecha: 27 oct 2026 · Rama: `feature/auto-recovery-p1` (a partir de `73b380d`) · Sin push.

## Veredicto

**P1 queda implementado y probado, pero no se declara autonomía completa.**

- Lo que se comprobó con Claude y Codex reales: Automata se recupera de **dos interrupciones forzadas** (proceso eliminado a mitad de una ronda de Claude y a mitad de una revisión de Codex) **sin ninguna intervención humana** después de pulsar Iniciar, y llega a `complete` con las verificaciones en verde y un commit decidido por el director.
- Lo que **no** se pudo comprobar en real: un **límite de uso** de ninguno de los dos planes, el máximo de turnos de Claude, un JSON inválido de Codex y un fallo de red. Ninguno ocurrió durante las pruebas y no hay forma segura de provocarlos a voluntad. Esos caminos están probados con CLI simuladas que imitan los mensajes encontrados en los binarios de las CLI instaladas, y la política tiene un respaldo genérico (espera progresiva acotada) por si los mensajes reales difieren.

| Commit | Contenido |
|---|---|
| `da76a6d` | Clasificación de errores, estado `waiting`, reintentos acotados, correcciones del director, idempotencia, reencolado del chat, Git incierto, `autoResume`, memoria de recuperación, archivos borrados |
| `dfa8fbf` | Interfaz: motivo, agente y hora de la espera; Continuar ahora, Pausar y Detener; ajustes `autoResume`, `maxRetries` e inicio con Windows; Electron |
| `c795eb0` | Auditoría de secretos, prueba de interfaz en Chrome, simulacro real, documentación |
| *(este commit)* | Corrección del texto del recuerdo de cierre y este reporte |

---

## 1. Qué se construyó, por requisito

| # | Requisito | Dónde | Cómo |
|---|---|---|---|
| 1 | Clasificar errores | `server/recovery.mjs` (`classifyError`), `server/agents.mjs` | Siete veredictos: `limit`, `transient`, `context` (sesión demasiado larga), `malformed`, `turns`, `fatal`, `aborted`. El adaptador adjunta al error `role`, `exitCode`, `subtype` del resultado de Claude, `rateLimit` (del evento `rate_limit_event` de Claude o del error `usage_limit_exceeded` de Codex), el último mensaje y si el agente llegó a trabajar. Errores de cuenta, instalación o modelo son fatales y se dejan a la persona. |
| 2 | Reintentos acotados y hora de restablecimiento | `recovery.mjs` (`parseResetTime`, `resetFromInfo`, `planWait`) | Hora leída de epoch (`…\|1719072000`, `resets_at`), fechas ISO, «in 3 hours 12 minutes», «resets 3pm (America/Los_Angeles)», «Try again at 15:40», `retry_in_ms`. Hora confiable: esperar hasta ella más un minuto (no se confía en horas pasadas ni a más de 24 h). Sin hora: 5, 15, 30 y 60 min, máximo 8 esperas por etapa. Fallo pasajero: 30 s, 2, 5 y 10 min hasta `maxRetries` (4 por defecto, 0 a 10). Tope global de 40 esperas por trabajo. Después, `error` con el motivo. |
| 3 | Estado `waiting` persistente | `coordinator.mjs` (`recover`, `scheduleWait`, `resumeNow`) | `run.waiting = { kind, role, reason, resumeAt, reliable, attempt, maxAttempts, stage, round }` y `run.resumeAt`, guardados en `runs.json`. El temporizador revisa cada minuto como máximo (sobrevive a que la PC duerma). La etapa pendiente se conserva y es la única que se repite. `run.recovery.log` registra cada cierre, espera, reanudación y rendición. |
| 4 | Tres intentos de corrección del director | `coordinator.mjs` (`review`), `prompts.mjs` (`reviewFixPrompt`), `config.mjs` (`invalidReview`) | JSON inválido, respuesta vacía, sin siguiente tarea, aprobación sin evidencia, hallazgo major con `complete` y aprobación con verificaciones fallidas se devuelven al director en la **misma sesión** con el motivo exacto, hasta 3 veces (`MAX_REVIEW_FIXES`). Si faltan las verificaciones de la ronda no es culpa suya: se ejecutan una vez y se le vuelve a preguntar. |
| 5 | `autoResume` y arranque con Windows | `config.mjs`, `coordinator.mjs` (`restoreRuns`, `startAutoResume`), `server/index.mjs`, `desktop/main.cjs` | `autoResume` activado por defecto: al abrir, un trabajo que estaba corriendo, esperando o cortado por el cierre continúa solo a los 1,5 s, tras comprobar las dos cuentas igual que **Continuar**. `autoStart` desactivado por defecto; solo la app empaquetada registra o quita el elemento de inicio de sesión (`app.setLoginItemSettings`) y solo cuando la persona cambia la casilla. |
| 6 | No repetir operaciones completadas | `agents.mjs` (`attemptId`, `<fase>-result.json`), `coordinator.mjs` (`invoke`, `restoreRuns`, `restoreMessages`, etapa `apply`, `queueGit`, `runGit`) | Cada llamada tiene un identificador persistente en `run.inflight` / `message.inflight`. El resultado se escribe en disco con ese id solo si la llamada terminó bien; al reabrir, si existe, se usa sin volver a llamar al agente. La revisión se guarda y pasa a la etapa `apply` **antes** de ejecutar Git u ofrecer correr la app. La cola de Git descarta decisiones repetidas de la misma ronda. Una operación de Git marcada `startedAt` sin `doneAt` al reabrir queda `uncertain` y solo la persona puede repetirla o descartarla. Un mensaje del chat interrumpido se reencola **una sola vez**, conservando las respuestas que ya tenía; a la segunda queda interrumpido. |
| 7 | Memoria del proyecto | `memory.mjs` (tipo `recovery`), `coordinator.mjs` | Cada cierre, espera, reintento, corrección del director y rendición queda como recuerdo `recovery` escrito por Automata. Se ve en el panel Memoria y, en 3 líneas como máximo y con la menor prioridad, al final del bloque de memoria de los prompts. |
| 8 | Interfaz | `public/app.js`, `index.html`, `i18n.js`, `styles.css` | Estado «Esperando para continuar»; la barra inferior dice «Límite de uso de Claude · sigue a las 15:40 (intento 1/8) · Puedes continuar ahora, pausar o detener. Motivo: …»; el panel del agente afectado muestra la causa y la hora, el otro «Espera a que Claude pueda continuar»; evento «ESPERA» en la actividad; Git incierto con **Repetir** / **Descartar**; recuerdos con archivos borrados marcados. Español e inglés. |
| 9 | Pausar y Detener mandan | `coordinator.mjs` (`control`) | Durante la espera, **Pausar** cancela la cita y deja el trabajo en pausa; **Detener** lo detiene; **Continuar ahora** salta la espera. Un trabajo detenido o pausado a propósito nunca se reanuda solo; cerrar la app no cuenta como Detener (`interruptedBy: "close"`). Ningún reintento es indefinido (topes por etapa y por trabajo). |
| 10 | Nada externo con resultado incierto se reintenta solo | `restoreRuns`, `runGit`, `resolveGit` | Push y merge que estaban en curso al cerrar quedan `uncertain`. Las propuestas de correr la app y las decisiones de Git son idempotentes por ronda. Automata no ejecuta compras ni publicaciones; las acciones externas que Claude haga por su cuenta no se repiten porque, tras un corte, Claude recibe la instrucción de revisar el estado y continuar sin repetir lo hecho, o su trabajo parcial pasa al director. |

### Seguridad y memoria

- **Aislamiento por proyecto:** sin cambios; los recuerdos de recuperación van al archivo del proyecto. Las carpetas de datos de los simulacros fueron propias (`artifacts/real-recovery-*/data`), sin tocar `%APPDATA%\Automata\workspace` ni la Automata abierta.
- **Permisos:** no se debilitó nada. Los simulacros reales corrieron con acceso **limitado** (Claude `acceptEdits`, Codex `read-only`), `apiKeySource: "none"` en todas las llamadas de Claude. La reanudación automática pasa por la misma comprobación de cuentas que el botón Continuar; si falla, espera 5 minutos más sin gastar intentos.
- **Archivos borrados en la memoria:** `staleMentions()` marca los recuerdos que mencionan rutas relativas con carpeta que ya no existen, rutas absolutas inexistentes y nombres sueltos que no están en los dos primeros niveles del proyecto. No se retira nada: el panel muestra «⚠ Menciona archivos que ya no existen» y el prompt añade «(⚠ ya no existe: …)» para que el director lo retire si corresponde.
- **Auditoría de registros históricos:** `node scripts/audit-secrets.mjs` sobre `%APPDATA%\Automata\workspace`: 142 archivos de texto y 0 bases de memoria (las bases viven en otra carpeta de datos). Resultado: **0 coincidencias con formas de credencial** (claves de API, tokens de GitHub, JWT, PEM, contraseñas en URL o asignaciones `password=`) y 99 líneas en 16 archivos marcadas solo por la heurística de alta entropía. Se revisaron por categoría sin imprimir los valores: 58 firmas de razonamiento de Claude (`"signature":"…"`), 20 identificadores `toolu_…`, 4 imágenes base64, 4 URL de Gradle/Android con sumas, nombres de carpetas de JDK y salidas de PowerShell. **No son secretos y no se reescribió ningún archivo.** El reporte está en `artifacts/secret-audit-2026-10-27T18-56-00-812Z.json`. El modo `--quarantine` (mover el original a `quarantine/<fecha>/` con permisos de solo dueño, verificar que el archivo redactado siga siendo JSON válido y dejar un manifiesto con SHA-256 de ambas versiones) está implementado y no se ejecutó porque no había nada que reemplazar.
- **Hallazgo derivado:** la misma heurística redactaba los identificadores `toolu_…` y `msg_…` en los registros nuevos (desde `61c00e9`), rompiendo el vínculo entre una herramienta y su resultado en el `.jsonl`. Corregido en `redact.mjs`: los prefijos de identificadores conocidos de las CLI no se consideran secretos; una clave con la misma forma sin prefijo sigue ocultándose (probado).
- **Configuración global:** sin cambios en Claude, Codex, Windows ni el entorno. El elemento de inicio de sesión es una entrada por usuario que solo existe si la persona activa la casilla.
- **Sin agentes, frameworks ni servicios nuevos.** Un módulo nuevo (`server/recovery.mjs`) sin dependencias.

---

## 2. Pruebas

### Automáticas: 133 de 133 (antes 115)

`test/recovery.test.mjs`, 18 pruebas:

1. Clasificación: límite con hora en Los Ángeles, epoch, Codex con `resets_at`, «Try again in 2 hours 5 minutes», 429, `spend limit … resets 2026-10-28 00:00 UTC`, hora pasada no confiable; pasajeros (`fetch failed`, `ECONNRESET`, flujo cortado, `overloaded_error`, 502, límite de tiempo, salida sin explicación); fatal para errores internos, cuentas, instalación y modelo; `context`, `malformed`, `turns`, `aborted`.
2. Política de espera: progresiva, exacta, topes por etapa y por trabajo, textos en español e inglés.
3. Límite del director: `waiting` con `resumeAt`, etapa conservada, reanudación sola desde la misma etapa, sin repetir la tarea ni la ronda, recuerdo en la memoria.
4. Claude con trabajo parcial: la ronda conserva su número, el prompt lleva «no repitas lo que ya está hecho», el director ve lo escrito antes del corte.
5. Fallo pasajero: espera creciente hasta `maxRetries`, luego `error`; Continuar reinicia los contadores; Detener.
6. Director: dos JSON inválidos y uno válido continúan; aprobación sin evidencia tres veces → `error` con el motivo; el prompt completo lleva el motivo cuando no hay sesión.
7. Turnos agotados: trabajo parcial a verificación y el director decide.
8. Cierre y reapertura: resultado en vuelo reutilizado sin llamar a Claude; sin resultado, el parcial pasa a verificación; `autoResume` desactivado deja todo interrumpido.
9. Detenido y pausado no se reanudan; cerrar la app deja `interruptedBy: "close"` y al reabrir continúa.
10. Espera guardada: pasada → reanuda; futura → espera; Detener y Pausar la cancelan; Continuar ahora la salta; `autoResume` desactivado → interrumpido.
11. Cuentas no listas al reanudar: espera 5 minutos más, no falla.
12. Chat interrumpido: conserva respuestas, recupera el resultado en vuelo, solo pregunta a los agentes que faltan, lleva la nota de no repetir.
13. Git incierto: no se repite solo; la persona lo repite.
14. Cierre en la etapa `apply`: ni el director ni el commit se repiten.
15. CLI simuladas: `rate_limit_event` + resultado fallido, `error_max_turns` con trabajo, error `usage_limit_exceeded` de Codex con hora, `turn.failed` pasajero, límite al retomar sesión sin abrir otra, archivo de resultado con el id del intento.
16. Ajustes y API: validación de `autoResume`, `maxRetries`, `autoStart`; `capabilities`; `waiting` por HTTP y Continuar por HTTP.
17. Identificadores de las CLI no se confunden con secretos.
18. Archivos borrados marcados en el panel y en el prompt, sin retirar.

**Dos pruebas anteriores cambiaron de expectativa a propósito** (documentado en `docs/VALIDATION.md`): «una consulta en proceso al cerrar» ahora se reencola una vez (antes quedaba interrumpida) y «la corrección directa tiene un tope» ahora devuelve la aprobación con verificaciones fallidas al director tres veces antes del error (antes era un error directo). Las 113 restantes no cambiaron.

### Interfaz en Chrome

- `node scripts/smoke-waiting.mjs`: **12 de 12**. Capturas en `artifacts/smoke-waiting-2026-10-27T19-00-56-672Z/`: espera con motivo, agente y hora; botones disponibles; inglés; pausa que cancela la cita; final en la ronda 1 sin repetirla; teléfono sin desbordamiento; sin errores ni peticiones externas.
- `node scripts/smoke-memory.mjs`: 13 de 13 después de los cambios del panel.

### Real, con Claude y Codex: dos simulacros

Montaje común: `scripts/real-recovery.mjs` levanta una **segunda instancia** del servidor (`--port 4791 --data artifacts/real-recovery-*/data`), registra el proyecto aislado `C:\Users\cellh\Automata Projects\paso1-recuperacion` (la prueba de aceptación del Paso 0 v2, sin implementación), pulsa Iniciar por la API (**única intervención humana**) y, cuando el agente elegido lleva al menos dos acciones en la etapa elegida, **elimina el árbol de procesos con `taskkill /f`** (servidor y CLI a la vez, sin guardar nada). Vuelve a levantar el servidor con la misma carpeta de datos y solo observa. Claude `claude-sonnet-5-5` (razonamiento medio), Codex `gpt-6-luna`, acceso limitado, `apiKeySource: "none"`.

**Simulacro 1: corte de Claude en plena ronda 1** (`artifacts/real-recovery-2026-10-27T18-59-41-200Z/`)

| Hora | Qué pasó |
|---|---|
| 18:59:41 | Iniciar. Codex planifica: «Implementa únicamente src/cuenta.mjs…» |
| 19:00:09 | Claude lleva 2 acciones (Glob, Read) en la ronda 1 → **taskkill**. El `.jsonl` de la ronda tiene 9 líneas y el marcador del intento |
| 19:00:11 | Reabre: `interrupted`, etapa `checks` (el parcial de Claude pasa a verificación), `recovery.log` con el cierre |
| 19:00:12 | **Reanuda sola** (`how: "startup"`, 1,7 s después, tras comprobar las cuentas). Verificaciones: aceptación falla, integridad aprobada |
| 19:00:13–19:01:04 | Corrección directa 1/3 y 2/3; en la ronda 3 pasan las 2 verificaciones; la memoria registra 2 errores con su solución |
| 19:01:05–19:03:21 | Codex revisa (continue), ronda 4, revisa (continue), ronda 5 |
| 19:03:44 | Codex `complete` con evidencia en los 5 criterios y 0 hallazgos; `commit cbdaec4` automático; merge en `main` pendiente de aprobación (`ask-push`) |

Verificación independiente después: 8 de 8 pruebas de aceptación, árbol limpio, 4 llamadas a Codex (568 623 tokens de entrada), 599 698 tokens en total. Recuerdos en la memoria: 5 pendientes automáticos, 1 `recovery`, 1 avance (commit). Intervenciones humanas: **1**.

**Simulacro 2: corte de Codex en plena revisión** (`artifacts/real-recovery-review-2026-10-27T19-04-20-178Z/`)

| Hora | Qué pasó |
|---|---|
| 19:04:20 | Iniciar (proyecto reiniciado al commit de la prueba de aceptación) |
| 19:04:39–19:05:21 | Ronda 1; verificaciones fallan; corrección directa; ronda 2 |
| 19:05:53 | Codex lleva 2 acciones de inspección en la revisión de la ronda 2 → **taskkill** |
| 19:05:55 | Reabre: `interrupted`, etapa `review`, ronda 2 (sin resultado en vuelo: el intento no había terminado) |
| 19:05:56 | **Reanuda sola**; repite solo la revisión, en la **misma sesión** de Codex (el `.jsonl` de la ronda 2 tiene 2 marcadores de intento) |
| 19:06:09 | `complete`, 5 de 5 criterios, 0 hallazgos, `commit 1444bda` |

Verificación independiente: 8 de 8 pruebas, 182 571 tokens, intervenciones humanas: **1**.

En ninguno de los dos simulacros hubo un estado `waiting`: no apareció ningún límite ni fallo pasajero real.

---

## 3. Fallas y limitaciones

1. **Límites de cuota reales: no probados.** Ni Claude ni Codex alcanzaron un límite durante las pruebas. Los patrones vienen de cadenas encontradas en los binarios instalados (Claude Code 2.1.311: `rate_limit_event`, `rate_limit_info`, `resets_at`, `retry_in_ms`, «Usage limit reached», «resets at»; Codex 0.158.0: `usage_limit_exceeded`, `rate_limit_exceeded`, `UsageLimitReachedError { resets_at }`, «You've hit your usage limit», «Try again») y de formatos anteriores conocidos (`…|epoch`). El nombre exacto de los campos de `rate_limit_info` y la forma del error de Codex en `exec --json` son suposiciones razonables, no observaciones. Por eso: (a) todo límite sin hora legible cae en la espera progresiva; (b) un límite que las CLI expresen como un error no reconocido se trata como fallo pasajero y se reintenta hasta `maxRetries` (30 s, 2, 5 y 10 min), lo que de todos modos no bloquea ni gasta más que cuatro llamadas fallidas; (c) cuando ocurra un límite real conviene revisar `runs/<id>/round-NN/*.jsonl` y afinar los patrones.
2. **Máximo de turnos, JSON inválido y fallos de red: solo con CLI simuladas.** En los simulacros reales ambas CLI respondieron bien. El camino está probado con procesos que imitan la salida real.
3. **Cierre ordenado de la app de escritorio: solo con prueba unitaria.** Los simulacros reales usan `taskkill /f` (crash). El camino `close()` → `interruptedBy: "close"` → reanudación está cubierto por `test/recovery.test.mjs`, no con Electron real. El paquete de Windows no se reconstruyó en esta fase, así que el elemento «Abrir Automata al iniciar Windows» tampoco se probó en la app instalada (la casilla queda oculta fuera de la app empaquetada).
4. **Horas con cambio de horario.** `resets 3pm (America/Los_Angeles)` se convierte con el desfase de la zona en el momento actual; en la noche de un cambio de horario puede desviarse una hora. El margen de un minuto no lo cubre; el efecto sería una llamada rechazada y otra espera.
5. **Trabajo parcial de Claude tras un cierre.** Si Automata se cierra mientras Claude edita, Claude muere con el proceso; al reabrir, su trabajo parcial pasa a verificación y al director (no se intenta continuar su sesión), porque no hay forma de saber qué alcanzó a hacer. El director lo vio en los dos simulacros y continuó sin problema, al costo de una ronda más.
6. **Acciones externas de Claude.** Automata no puede saber si Claude llegó a ejecutar algo externo (por ejemplo `adb install`) justo antes de un corte. La protección es la instrucción de continuar sin repetir y el criterio del director; no hay un registro transaccional de lo que Claude ejecuta.
7. **Chat reencolado solo con `autoResume`.** Con la opción desactivada, un mensaje interrumpido se muestra interrumpido y no se reenvía (comportamiento anterior).
8. **Falsos positivos de la heurística de entropía en registros antiguos.** Las 99 líneas marcadas no son secretos; se dejaron intactas. Si en el futuro aparece un secreto real, `--quarantine` lo reemplaza con copia verificable.

---

## 4. Evidencia

| Qué | Dónde |
|---|---|
| Pruebas automáticas | `npm test` → 133 de 133 |
| Interfaz | `artifacts/smoke-waiting-2026-10-27T19-00-56-672Z/` (`report.json`, `01-esperando.png`, `02-waiting-en.png`, `03-pausado.png`, `04-completado.png`) |
| Simulacro 1 | `artifacts/real-recovery-2026-10-27T18-59-41-200Z/report.json`, `server-1.log`, `server-2.log`, `data/runs/8ac06997…/round-01/code-coder.jsonl` (corte), `data/runs.json` (`recovery.log`), `data/memory/*.db` |
| Simulacro 2 | `artifacts/real-recovery-review-2026-10-27T19-04-20-178Z/report.json`, `data/runs/7213c9a5…/round-02/review-auditor.jsonl` (dos intentos en la misma sesión) |
| Proyecto de los simulacros | `C:\Users\cellh\Automata Projects\paso1-recuperacion` (commit `1444bda` del segundo simulacro) |
| Auditoría de secretos | `artifacts/secret-audit-2026-10-27T18-56-00-812Z.json` |
| Documentación | `docs/ARCHITECTURE.md` («Recuperación autónoma (P1)»), `docs/VALIDATION.md` |

Los artefactos no van en Git (`artifacts/` está ignorado); quedan en esta PC.

## 5. Siguientes pasos

1. Dejar un proyecto mediano trabajando varias horas con la app de escritorio hasta que ocurra un límite real, y revisar el `.jsonl` del momento para confirmar los patrones (es la validación que falta para P1).
2. Reconstruir el paquete de Windows y probar «Abrir Automata al iniciar Windows» y el cierre ordenado con reanudación en la app instalada.
3. P2 del roadmap: plan de tareas persistente y chat con memoria.
