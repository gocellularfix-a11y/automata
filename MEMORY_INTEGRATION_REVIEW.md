# Memoria persistente para Automata: revisión de claude-mem, local-mem y Cortex

Fecha: 26 oct 2026 · Rama: `feature/director-observa-planes`

Método:
- Se clonó cada repositorio (`--depth 1`) en una carpeta temporal aislada y se leyó su código sin instalar ni ejecutar nada.
- Las afirmaciones clave se volvieron a comprobar con `grep` sobre el código (marcadas ✔).
- También se comprobaron las CLI instaladas en esta PC y el Node que usa Automata.

---

## 1. Recomendación

**No integrar ninguno de los tres como dependencia.** En su lugar, Automata debe tener un módulo de memoria pequeño (`server/memory.mjs`) construido sobre tecnología que ya existe:

- **El motor:** SQLite con búsqueda de texto completo (FTS5), que ya viene dentro del Node de Electron. Comprobado en esta PC: Node 24.15, SQLite 3.51.3, `node:sqlite` con FTS5 y BM25 funcionando. No se instala nada.
- **La captura:** la que Automata ya hace hoy. Lee los eventos de las dos CLI (`decodeEvents` en `agents.mjs:156`), lleva la bitácora del codificador (`watch.mjs`), guarda los resultados de las verificaciones (`runChecks`) y las revisiones del director (`review.json`). No hacen falta hooks globales.
- **Piezas de local-mem** (MIT, JavaScript puro), adaptadas con su aviso de licencia:
  - la redacción de secretos,
  - el saneamiento de consultas FTS,
  - el esquema con triggers y migraciones,
  - el resumen por herramienta (`distill`),
  - el reparto de presupuesto de tokens (`allocateBudget`).

**Por qué no es «otro motor de memoria»:** el motor es SQLite y la captura ya existe. Lo nuevo son dos cosas que **ninguno de los tres repositorios tiene**: el registro estructurado *error → solución* y el campo de memoria del director. Más una inyección acotada en los prompts que Automata ya arma.

**Por qué no los tres:** los tres instalan hooks o plugins **globales** que cambian el comportamiento de Claude en todos los proyectos, y ninguno guarda una base de datos separada por proyecto por defecto. Además:
- **claude-mem** consume la cuota del plan Max con una llamada al modelo por cada uso de herramienta, envía telemetría por defecto, tiene la redacción de secretos apagada y agrega su propio sistema de tareas.
- **Cortex** necesita Python, unos 1 GB de modelos y 126 000 líneas de código.
- **local-mem** necesita Bun y no soporta Codex.

---

## 2. Respuestas a las preguntas

| Pregunta | claude-mem | local-mem | Cortex | Automata + memory.mjs |
|---|---|---|---|---|
| ¿Registra automáticamente las sesiones que corre Automata? | **Sí**, Claude y Codex, pero con hooks y plugins globales. Capturaría también `codex exec` (`hook-constants.ts:93`). | Solo Claude, con hooks globales | Claude con plugin global; Codex con plugin y hooks que el usuario debe aprobar. Sin evidencia para `codex exec`. Sin hooks, el agente tiene que llamar a `remember` él mismo. | **Sí, sin hooks:** Automata ya lee cada evento de las dos CLI |
| ¿Claude y Codex comparten memoria? | Misma base de datos, pero al iniciar cada CLI ve solo lo suyo (`SESSION_START_INCLUDE_ALL_SOURCES: 'false'`) | No (sin Codex) | Sí, el mismo almacén | Sí, por diseño: un solo almacén por proyecto que Automata inyecta a los dos |
| ¿Recupera sin gastar mucho contexto? | Bien: índice de 50 observaciones y detalle a pedido | **Bien:** presupuesto de 150, 800 o 1 200 tokens por secciones | Regular: `recall` devuelve hasta 75 000 caracteres; los hooks inyectan 800 | Presupuesto fijo, unos 1 500 tokens (se reutiliza `allocateBudget`) |
| ¿Historial detallado para auditoría? | **Sí:** entrada y salida cruda de cada herramienta, hasta 64 KB, para siempre | No: resúmenes cortados (500 caracteres de salida) | No: comprime y reescribe los recuerdos (guarda el original en `memory_archives`) | **Ya existe:** `runs/<id>/round-NN/` guarda prompts, JSONL crudo, verificaciones y revisiones |
| ¿Funciona en Windows? | Sí, con CI en Windows y muchas correcciones; instala Bun y uv solo | Sí (el autor usa Windows), pero necesita Bun | CI en Windows, pero los hooks usan `bash -c … python3`; necesita Python | Sí: el Node de Electron, comprobado |
| ¿API keys, servicios o costos? | Llama a Claude (Haiku) con **tu plan Max** por cada uso de herramienta y al terminar; telemetría PostHog **activada**; ofrece cuenta en cmem.ai | Resumen por IA opcional **con API key**; consulta GitHub en cada inicio | Sin LLM por defecto; descarga unos 1 GB de PyPI y Hugging Face | Ninguno |

### Requisitos

| Requisito | claude-mem | local-mem | Cortex | memory.mjs |
|---|---|---|---|---|
| 1. Aislada por proyecto | ✗ Una base global. La clave es el nombre de carpeta: dos proyectos con el mismo nombre se mezclan (`project-name.ts:41-56`). | ✗ Una base global y filtro por `cwd`. `project_dna` acepta cualquier `cwd`. | ✗ Una base global; `recall` sin `domain` busca en todos | ✓ Un archivo `.db` por proyecto |
| 2. Sobrevive a reinicios | ✓ | ✓ (WAL) | ✓ | ✓ (WAL) |
| 3. Errores de compilación y prueba con su solución | ✗ Solo texto libre escrito por el modelo (`bugfix`, `gotcha`) | ✗ Solo `[exit N]` y un fragmento de la salida | ✗ Solo un resumen si la salida dice «error» | ✓ Tabla `errors` ligada a la ronda que los resolvió |
| 4. Sin credenciales ni secretos | ✗ **Redacción apagada por defecto** (`CLAUDE_MEM_REDACT_ENABLED: 'false'` ✔); un `.env` leído se guarda crudo | ~ 22 patrones, con huecos (JSON, entropía) | ✓ Reglas de gitleaks en cada escritura | ✓ Patrones de local-mem corregidos, el `redact()` actual y la exclusión de archivos sensibles (`isSensitivePath`) |
| 5. No alterar las CLI globales | ✗ Plugin en `settings.json` con `autoUpdate`, `config.toml` de Codex, PATH; puerta que **niega lecturas** de archivos grandes | ✗ 4 hooks en `settings.json` y MCP a nivel de usuario | ✗ 11 hooks globales; `decision_gate` **bloquea ediciones** con 8 o más líneas de comentario (✔ `decision_gate.py:36,150-161`) | ✓ No toca las CLI |
| 6. Sin otro sistema de coordinación | ✗ `work_state_*` se presenta como «la lista de tareas canónica» del agente; trabajos de fondo que lanzan Claude o Codex | ✓ | ~ Trabajos de consolidación en segundo plano | ✓ |

---

## 3. Evidencia técnica por repositorio

### claude-mem: thedotmack/claude-mem, v15.3.0

- **Licencia:** Apache-2.0 (era AGPL-3.0 antes de la 13.0). **`cowork/` es `PolyForm-Noncommercial-1.0.0`** (✔ `cowork/.claude-plugin/plugin.json:10`). Hay una frontera *open-core* con partes comerciales reservadas (`docs/ip-boundary.md`).
- **Popularidad y ritmo:** unas 103 000 estrellas, 115 incidencias abiertas, 378 versiones (17 a 36 al mes en 2026). Son unas 160 000 líneas de TypeScript.
- **Arquitectura:**
  - Node y **Bun** (`bun:sqlite`). El instalador los descarga con `irm bun.sh/install.ps1 | iex` y el instalador de astral (uv).
  - Un daemon Express en `127.0.0.1:37777` que **nunca se apaga solo** (✔ `CLAUDE_MEM_IDLE_EXIT_SEC: '0'`).
  - Chroma como proceso Python con `uvx`, para la búsqueda por vectores.
- **Seguridad:**
  - «The worker's HTTP surface has no request authentication; its only defence is the loopback bind» (✔ `middleware.ts:228`). Cualquier proceso local puede leer todas las memorias y las salidas crudas, cambiar la configuración o borrar.
- **Costo:**
  - ✔ `CLAUDE_MEM_CLAUDE_OBSERVATION_BATCH_SIZE: '1'`: una llamada al modelo por cada evento de herramienta, más un resumen en cada `Stop`, más un trabajo «My Work» de fondo.
  - Todo sale de la cuota del plan Max. Tiene un freno al 95 % de la ventana de 5 horas.
  - Un ciclo de Automata con 30 usos de herramienta sumaría unas 30 llamadas extra.
- **Comportamiento:**
  - La «File Read Gate» (✔ `CLAUDE_MEM_FILE_READ_GATE_ENABLED: 'true'`) puede negarle a Claude leer completo un archivo de 32 KB o más.
  - Telemetría PostHog activada salvo `DO_NOT_TRACK` (✔ `consent.ts:40-49`).
- **Lo mejor que tiene:**
  - Captura cruda completa (tabla `tool_uses`).
  - Divulgación progresiva en la búsqueda.
  - Soporte maduro de Windows.
- **Por qué no sirve en modo solo HTTP:** sin hooks, guardar desde Automata con `POST /api/memory/save` es un `INSERT` directo sin IA (`save-memory.ts:42-46`). Eso Automata lo hace con `node:sqlite` sin un daemon ni Bun.
- **Punto a verificar:** usa el login de la suscripción de Claude desde un proceso de fondo de terceros. Conviene revisar los términos vigentes de Anthropic para ese uso.

### local-mem: Teddorf/local-mem, v0.12.0

- **Licencia:** MIT.
- **Mantenimiento:** 1 estrella, un solo autor, sin cambios desde el 10 mar 2026. Gran parte la generó Claude: `run-implementation.bat` lo corre con `--dangerously-skip-permissions`.
- **Arquitectura:**
  - **Solo Bun** (✔ `import { Database } from 'bun:sqlite'`, `db.mjs:1`). Sin dependencias.
  - Base global en `~/.local-mem/data/local-mem.db` (✔ `db.mjs:7`).
  - MCP por stdio, sin puertos.
- **Captura:** 4 hooks de Claude:
  - `SessionStart`
  - `UserPromptSubmit`
  - `PostToolUse` (resumen por herramienta)
  - `SessionEnd` (lee el transcript)
  - **Sin Codex.**
- **Problemas:**
  - Consulta `raw.githubusercontent.com` en cada inicio (✔ `constants.mjs:241`) y mete el aviso en el contexto, aunque el README promete «sin red».
  - Cada 25 herramientas ejecuta `tsc --noEmit` y `bun test` del proyecto (`observation.mjs:174-214`).
  - Su marca de error revisa el *comando*, no el código de salida (`observation.mjs:169`).
  - El desinstalador deja el registro MCP de usuario (`uninstall.mjs:39-43`).
  - Carrera en las migraciones.
- **Lo que vale la pena reutilizar** (unas 600 a 800 líneas, de 1 a 2 días):

  | Pieza | Archivo | Cambio necesario |
  |---|---|---|
  | Redacción de secretos (22 patrones y nombres de archivo sensibles) | `scripts/redact.mjs` (87 líneas) | Corregir los huecos: claves JSON entre comillas y alta entropía |
  | `sanitizeFtsQuery` | `scripts/db.mjs:145-162` | Ninguno |
  | Esquema, triggers FTS5 y migraciones versionadas | `scripts/db.mjs:9-377` | Pasar a `node:sqlite` `DatabaseSync`; migraciones dentro de una transacción |
  | `distill()`, resumen por herramienta | `scripts/observation.mjs:46-161` | Adaptarlo a los eventos de `decodeEvents` |
  | `allocateBudget`, presupuesto por secciones | `scripts/session-start.mjs:481-522` | Ninguno |

### Cortex: cdeust/Cortex («hypermnesia-mcp» 4.23.5)

- **Licencia:** MIT. Los modelos MiniLM son Apache-2.0. Los extras opcionales `leidenalg` e `igraph` son GPL (dato de conocimiento general, no del repositorio).
- **Mantenimiento:** 75 estrellas, un solo mantenedor, unas 126 000 líneas de producto, 906 ADR y 62 versiones en 3 semanas.
- **Arquitectura:**
  - **Python ≥ 3.11 con uv.** Dependencias obligatorias: `sentence-transformers` (✔ arrastra torch) y `flashrank`.
  - Modelos de unos 1 GB descargados de Hugging Face.
  - SQLite en `~/.claude/methodology/memory.db`. Intenta primero PostgreSQL local; en Windows lo rechaza y usa SQLite.
- **Captura:**
  - Plugin de Claude con 11 hooks globales y plugin de Codex.
  - En modo solo MCP no captura nada automáticamente.
- **Problemas:**
  - `decision_gate` bloquea ediciones en **cualquier** repositorio (✔ `PROSE_RUN_LIMIT = 8`, devuelve 2).
  - La «consolidación» reduce los recuerdos a un *gist* a los 7 días y a una etiqueta a los 30, así que no sirve como auditoría.
  - `recall` sin `domain` busca en todos los proyectos.
  - `sync_instructions` escribe en el `CLAUDE.md` del proyecto.
- **Lo mejor que tiene:** la redacción basada en gitleaks (222 reglas) y la búsqueda híbrida local.
- **Veredicto:** está sobredimensionado para «recordar errores, soluciones y decisiones por proyecto», y exige empaquetar Python. Esfuerzo estimado: de 3 a 6 días, sin captura automática.

### Lo que ya traen las CLI (comprobado en esta PC)

- **Claude Code 2.1.311** acepta, por llamada:
  - `--settings <archivo>` (hooks)
  - `--mcp-config` y `--strict-mcp-config`
  - `--plugin-dir`
  - `--append-system-prompt`
  - `--disallowedTools`
- **Codex 0.158.0** acepta `-c clave=valor` y `--profile` por llamada.
- **Configuración global hoy:** `~/.claude/settings.json` sin hooks y `~/.codex/config.toml` sin servidores MCP.
- **Conclusión:** si algún día hiciera falta un hook o un MCP, se puede activar **solo para las llamadas de Automata**, sin tocar la configuración global.
- **Memoria propia de cada CLI:** Codex ya tiene la suya (`~/.codex/memories_1.sqlite`) y Claude tiene la suya. Las dos son globales y propias de cada herramienta: no se comparten ni están aisladas por proyecto. No cubren el requisito.

---

## 4. Riesgos

### Si se adoptara alguno de los repositorios

| Riesgo | claude-mem | local-mem | Cortex |
|---|---|---|---|
| Cambia el comportamiento global de Claude o Codex | Alto | Alto | Alto |
| Gasto de cuota del plan | **Alto** | Bajo | Bajo |
| Fuga de secretos | **Alto** (redacción apagada) | Medio | Bajo |
| Superficie de ataque local | **Alto** (HTTP sin autenticación) | Bajo | Bajo |
| Licencias | Medio (PolyForm-NC en `cowork/`, open-core) | Bajo | Bajo, salvo los extras GPL |
| Mantenimiento | Ritmo muy alto: muchas versiones, cambios frecuentes | Abandono (un autor) | Complejidad extrema |
| Peso | Bun, uv, Python y un daemon | Bun | Python, torch y unos 1 GB |

### Con memory.mjs propio

| Riesgo | Mitigación |
|---|---|
| Memoria equivocada que se repite (como el falso problema de codificación) | Cada hecho tiene origen, ronda y estado. El usuario puede borrarlo desde la interfaz, y el director puede marcarlo como retirado. |
| La memoria crece sin límite | Tope de hechos activos por proyecto y presupuesto fijo en el prompt. Lo viejo queda solo en la auditoría. |
| Secretos en las salidas de verificaciones | Redacción antes de guardar. No se guardan salidas de lecturas de archivos sensibles. |
| La búsqueda por palabras (FTS5) falla con sinónimos | Para errores alcanza: se busca por la firma del error (comando y primera línea normalizada). La búsqueda por vectores queda fuera hasta que haga falta. |
| `node:sqlite` es experimental en Node 24 | Es estable en la práctica y está en el Node de Electron. Acceso aislado en un solo módulo, con pruebas. |

---

## 5. Qué aporta lo elegido y qué tiene que hacer Automata

### Lo que se reutiliza (ya existe)

| Pieza | De dónde |
|---|---|
| Motor de almacenamiento y búsqueda con relevancia (SQLite, FTS5, BM25, WAL) | `node:sqlite` del Node de Electron |
| Captura de cada herramienta, comando, diff y resultado de Claude y Codex | `decodeEvents` (`agents.mjs:156`) y `observe` (`watch.mjs`) |
| Errores de verificación con comando, código y salida | `runChecks` (`agents.mjs:327`) |
| Decisiones y progreso del director | `review.json`: `summary`, `findings`, `criteria`, `git` |
| Auditoría completa | `runs/<id>/round-NN/*.jsonl`, prompts y `check-N.json` |
| Retomar contexto de la conversación | `--resume` y `exec resume` (`coordinator.mjs:197-245`) |
| Redacción, saneamiento FTS, esquema y migraciones, resumen por herramienta, presupuesto | local-mem (MIT), adaptado |
| Exclusión de archivos con secretos | `isSensitivePath` (`git.mjs:14`) |

### Lo que Automata tiene que implementar

1. **`server/memory.mjs`:** una base `.db` por proyecto en `%APPDATA%\Automata\workspace\memory\<projectId>.db`. Va fuera de la carpeta del proyecto: no ensucia el repositorio del usuario y los agentes no la editan. Tablas:
   - `facts` (tipo: `decision`, `env`, `progress`, `note`, `gotcha`; texto; origen; ronda; estado)
   - `errors` (firma, comando, extracto, primera ronda, ronda resuelta, solución)
   - `events` (registro breve que solo se agrega, para buscar)
   - FTS5 sobre `facts` y `errors`
2. **Enlace error → solución:**
   - Cuando una verificación falla, se guarda su firma.
   - Cuando la misma verificación vuelve a pasar, se marca resuelta con la ronda, los archivos cambiados (de la bitácora) y el extracto del reporte de Claude.
   - Si la firma reaparece, se inyecta la solución anterior.
3. **Campo `memory` del director:** se agrega a `REVIEW_SCHEMA` (`config.mjs:109`) y a `validateReview`, y el director lo usa para registrar hechos («JDK 21 en …», «la codificación UTF-8 está bien»). Es lo mismo que la prioridad P2 del roadmap.
4. **Inyección acotada** en `directorPrompt`, `coderPrompt` y `chatPrompt`, tanto en los prompts completos como en los cortos. Unos 1 500 tokens, por prioridad:
   - errores abiertos,
   - entorno,
   - decisiones,
   - progreso reciente,
   - soluciones relacionadas con lo que falla ahora (buscadas con FTS).
5. **Interfaz:** un panel «Memoria» con la lista, borrar o retirar un hecho y exportar.
6. **Pruebas** con `node:test`: aislamiento entre proyectos, persistencia tras reiniciar el coordinador, redacción, enlace error → solución, presupuesto y migraciones.

**Esfuerzo estimado:** de 3 a 5 días (de 600 a 900 líneas de código y sus pruebas), sin dependencias nuevas.

---

## 6. Plan mínimo de integración

1. **Módulo y pruebas** (día 1-2): `server/memory.mjs`, con las piezas de local-mem adaptadas en `server/redact.mjs` y su aviso MIT. Pruebas de aislamiento, persistencia y redacción.
2. **Captura en el coordinador** (día 2-3). Sin hooks:
   - después de `runChecks`, registrar o resolver errores;
   - después de cada revisión, guardar `memory`, el `summary` y los hallazgos;
   - en el chat, guardar la respuesta como `note`.
   - Todo en `coordinator.mjs` (`loop`, `drainChats`).
3. **Inyección** (día 3): `prompts.mjs` recibe el resumen de la memoria. Prueba: un hecho de la ronda 1 aparece en el prompt corto de la ronda 5 aunque se borren las sesiones.
4. **Interfaz** (día 4): panel «Memoria».
5. **Validación real** (día 5). Repetir el Paso 0 y un caso como el de la calculadora:
   - el falso problema de codificación no se repite después de quedar en memoria;
   - el JDK correcto se usa sin redescubrirlo;
   - un error de compilación ya resuelto se reconoce y se aplica su solución.

### Criterios de aceptación

1. Cada proyecto tiene su propio archivo de memoria. Un proyecto no puede leer la memoria de otro (prueba con dos proyectos).
2. La memoria sobrevive a cerrar Automata a mitad de una ronda.
3. Una verificación que falla y luego pasa queda como error resuelto, con la ronda y la solución. Si la firma reaparece, la solución se inyecta.
4. Ningún patrón de credencial de la batería de pruebas llega a la base de datos.
5. `~/.claude/settings.json` y `~/.codex/config.toml` no cambian (se comparan sus huellas antes y después).
6. No hay procesos, puertos ni trabajos de fondo nuevos: la memoria solo se escribe y se lee dentro de las operaciones del coordinador.
7. El bloque de memoria en un prompt no pasa de su presupuesto.

### Si más adelante hiciera falta captura dentro de la CLI

Por ejemplo, hooks de `PostToolUseFailure`. Se activarían **por llamada** con `claude --settings <archivo de Automata>`, nunca en la configuración global y solo con tu aprobación.
