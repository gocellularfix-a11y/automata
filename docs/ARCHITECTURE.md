# Automata 0.4.0

Una interfaz compartida para Windows y Android; un coordinador que trabaja en la PC.

## Componentes

- `public/`: interfaz adaptable, sin frameworks ni peticiones a CDNs. Dos paneles en escritorio y pestañas en móvil.
- `server/`: coordinador Node, persistencia local, procesos de agentes y verificaciones. Usa módulos estándar; no necesita paquetes de servidor.
- `desktop/`: aplicación Electron con contexto aislado, renderer sin Node y un puente IPC limitado. Un protocolo seguro `automata://app` sirve los recursos empaquetados; no abre un navegador externo.
- `android/`: aplicación Android con WebView del sistema, recursos empaquetados y sin puente JavaScript a Java. Se conecta a la PC.
- `Start-Automata.ps1`: entrada PowerShell para escritorio o coordinador sin interfaz.

Flutter no estaba instalado. Se implementó una interfaz compartida con Electron y un contenedor Android para compilar con las herramientas existentes. No hay una segunda interfaz móvil que mantener.

## Máquina de estados

`plan → code → checks → review → apply → code… → complete | blocked | limit`, con `waiting` como estado transitorio ante un límite de uso o un fallo pasajero (ver «Recuperación autónoma»). El director mantiene un plan de tareas persistente que guía las rondas (ver «Plan persistente»).

Solo un proceso de agente se ejecuta a la vez. El director inicial y el auditor son Codex. Las consultas a ambos se serializan. Pausar espera el final de la operación actual; detener cancela el proceso activo. Una interrupción del codificador se recupera verificando y auditando el trabajo parcial.

Cada ejecución conserva una copia de la definición del proyecto y de los modelos elegidos. Los cambios de modelo se aplican al siguiente trabajo; idioma y permisos se aplican a la siguiente operación. Para ampliar un límite alcanzado se actualiza el máximo y se continúa explícitamente.

Los comandos de verificación deben pertenecer a la ronda actual para aprobar. `complete` exige evidencia no vacía para todos los criterios originales y ningún hallazgo crítico/importante pendiente. El coordinador rechaza una aprobación si falló un comando. La inspección de AI sigue siendo falible: estas reglas comprueban el contrato, no prueban por sí solas la corrección del código.

## Permisos y datos

`accessMode=full` es el permiso solicitado para ambos agentes. Claude se inicia con `--permission-mode bypassPermissions`, sin una lista de herramientas que lo reduzca a lectura; Codex usa `--dangerously-bypass-approvals-and-sandbox`. Esto permite operaciones de archivo, comandos y red bajo la cuenta del proceso. No modifica las restricciones del entorno donde se desarrolla Automata, no eleva privilegios y no cambia políticas administradas de Windows/proveedor. `limited` conserva el comportamiento anterior. Las consultas `question` siempre usan modo de lectura, de forma explícita.

Los proyectos locales no requieren repositorio: las invocaciones de Codex exec incluyen `--skip-git-repo-check`. La evidencia Git es opcional; status y diff se limitan a la carpeta del proyecto con un pathspec. El modo completo permite inicializar o crear un repositorio cuando el usuario lo pide, sin convertir Git en un requisito para trabajar.

La PC escucha solo en loopback por defecto. `--lan` habilita la red local. Todos los endpoints API requieren un token aleatorio. El código para emparejar se muestra solo en la PC autenticada. El APK guarda la conexión en el almacenamiento privado de su WebView, no las credenciales de los proveedores.

El modo LAN admite HTTP para una red local de confianza; para acceso por Internet se debe usar HTTPS mediante una conexión privada o un proxy autenticado. No se incluye un servicio de nube ni un túnel público.

Los datos se guardan en `%APPDATA%/Automata/workspace` en escritorio y en `.automata/live` al ejecutar el servidor desde el repositorio. La demostración usa un directorio separado. Los prompts, reportes, sesiones y eventos se guardan localmente, fuera del control de versiones. Los reportes pueden contener código del proyecto.

## Modelos

Se incluyen los alias Haiku, Sonnet, Opus y Fable. La lista del director se pide a Codex (`codex debug models`, solo los modelos visibles para la cuenta; se guarda 10 minutos) con los niveles de razonamiento que admite cada uno; si Codex no responde se usan `gpt-6-sol`, `gpt-6-luna` y `gpt-6-astra`. El antiguo `gpt-6.1-sol`, que Codex rechaza con una cuenta de ChatGPT, se corrige al cargar los ajustes. Se pueden introducir otros identificadores. Las listas son opciones de configuración, no una certificación de acceso en las cuentas del usuario. Cada CLI decide disponibilidad y niveles admitidos; los errores se muestran y no se sustituyen por respuestas simuladas.

El razonamiento interno no se muestra. Los paneles contienen mensajes visibles, actividad de herramientas, reportes, verificaciones y decisiones. Los tokens se muestran solo cuando la CLI los reporta.

## Conexión de cuentas (0.2.0)

`server/auth.mjs` consulta `claude auth status --json` y `codex login status`. Distingue instalación ausente, sesión pendiente, desconexión, error y sesión disponible; no deduce autenticación porque exista un ejecutable o un archivo. Antes de iniciar o reanudar un trabajo real se vuelven a comprobar las dos cuentas. Las consultas comprueban el destinatario correspondiente. La demostración omite los proveedores.

La ventana de cuentas aparece al abrir un espacio real y se puede reabrir desde **Cuentas**. Inicia las CLI oficiales (`claude auth login --claudeai`, `codex login`, alternativa `codex login --device-auth`) sin un shell y muestra sus páginas oficiales en el navegador del sistema. Para el retorno manual de Claude se mantiene stdin abierto, aceptando únicamente el código solicitado. El login tiene tiempo límite, cancelación y cierre de su proceso al salir de Automata. Cambiar de cuenta mientras hay trabajo activo está bloqueado.

El endpoint `/api/auth` requiere el token del coordinador. Las mutaciones de acceso y los enlaces/códigos pendientes están limitados a loopback y no se exponen al origen Android. Solo se ofrecen URLs HTTPS de hosts oficiales permitidos. Los datos temporales del login no se guardan en disco, eventos, historial ni localStorage. Las credenciales persistentes y su renovación pertenecen a las CLI; Automata no implementa ni suplanta su servidor OAuth. La comprobación local de credenciales no verifica la disponibilidad de modelos, cuotas ni la vigencia remota de la cuenta.

Fuentes: [Autenticación de Codex](https://learn.chatgpt.com/docs/auth), [CLI de Claude Code](https://code.claude.com/docs/en/cli-reference) y [Autenticación de Claude Code](https://code.claude.com/docs/en/authentication).

## Local y GitHub (0.3.0)

`source` es `local` por defecto; los proyectos guardados antes de 0.3 siguen funcionando sin migrar sus carpetas. GitHub añade una URL canónica del repositorio, con validación estricta de HTTPS, host, owner y repo, sin credenciales ni parámetros.

`server/github.mjs` prepara la importación antes de registrar el proyecto. Clonar exige carpeta existente vacía y cuenta disponible en GitHub CLI; ejecuta `gh repo clone` con argumentos separados, sin shell, sin prompts de terminal y con tiempo límite. Un fallo no registra el proyecto ni borra archivos parciales. Solo se permite una importación simultánea y cerrar Automata aborta su proceso. Usar una copia existente verifica raíz y `origin` sin cambiarlos ni solicitar credenciales de red.

La cuenta GitHub es opcional en la ventana de cuentas: no cambia el contador ni el requisito de las dos AI. El login oficial por navegador/dispositivo y su estado se gestionan mediante GitHub CLI. La CLI conserva sus credenciales; Automata no solicita tokens ni registra su salida de login. Los enlaces y códigos de acceso permanecen limitados a la PC. Los commits, el push y el merge los decide el director y se describen en «Director de solo lectura, Git y flujo ágil».

Fuentes: [Codex fuera de Git](https://learn.chatgpt.com/docs/non-interactive-mode#git-repository-required), [login de GitHub CLI](https://cli.github.com/manual/gh_auth_login), [estado de GitHub CLI](https://cli.github.com/manual/gh_auth_status), [clonar un repositorio](https://cli.github.com/manual/gh_repo_clone).

## Inicio de Windows (0.1.1)

El error de pantalla blanca se reprodujo en el paquete real: Windows rechazaba la creación del token restringido de Chromium (`launch-failed`, código 49). El recurso HTML ni siquiera llegaba a ejecutarse. El primer paquete no había superado esta prueba y no debía describirse como listo.

La aplicación intenta primero el renderer con sandbox. Si Windows devuelve exactamente el código 49, guarda una preferencia de compatibilidad y se reinicia una vez con `sandbox: false`. Conserva `contextIsolation: true`, `nodeIntegration: false`, el puente IPC con validación de emisor, CSP y navegación exclusivamente local. La cabecera y Preferencias indican este modo. Se puede impedir con `--strict-renderer` o pedir explícitamente con `--compatibility`.

Los registros de inicio están en `boot.log` dentro de los datos de usuario. Se registran fallos de preload, carga y renderer. El cierre tiene un límite para no dejar un proceso invisible reteniendo el bloqueo de instancia.

## Procesos y consultas Windows (0.3.1)

El lanzador npm de Codex encontrado en la PC inicia el binario nativo mediante otro `spawn` sin `windowsHide`. Ocultar solo el primer proceso no ocultaba ese hijo. En Windows, Automata ahora resuelve el paquete opcional de arquitectura y ejecuta su `codex.exe` directamente con pipes y `windowsHide: true`, conservando los metadatos de instalación npm. Esto se aplica a consultas, planificación, auditoría y estado/login. Las rutas de instalación antiguas con `vendor/.../codex/codex.exe` también se detectan; los overrides de CLI explícitos siguen teniendo prioridad.

Una consulta cambia de `queued` a `processing` con `activeRole` al iniciar su turno. La API devuelve ese estado real y la UI ya no deduce la cola de `busy`, porque una consulta que está respondiendo también ocupa al coordinador. Las respuestas parciales a ambos agentes se publican al terminar cada turno. Un error libera al agente y queda en el panel. Al reabrir, las consultas que estaban procesándose se marcan interrumpidas, sin reenviarlas automáticamente.

## Tareas directas y permisos (0.4.0)

`task` ejecuta una petición desde el chat y devuelve texto, sin exigir el esquema JSON de revisión ni un ciclo activo. `question` mantiene consulta de solo lectura y `instruction` se entrega al plan activo. El destino puede ser coder, auditor o ambos; la cola serializa sus llamadas y pasa las respuestas previas al siguiente agente. Cada llamada conserva sus permisos y el resultado declara errores reales, sin sustituirlos por éxito.

Los modelos y límites de un trabajo se conservan en su snapshot. Un cambio explícito del permiso actualiza el permiso de las siguientes operaciones del trabajo activo; los argumentos del proceso ya iniciado no cambian. Los trabajos anteriores sin ese campo adoptan la selección actual al cargar.

Una tarea directa entregada justo antes de revisar invalida los checks de esa ronda. En revisiones con permiso completo se vigila el directorio del proyecto, excluyendo el almacenamiento propio, `.git`, `.automata` y `node_modules`. Si el director cambia archivos, no se acepta `complete`: se solicita otra entrega y se repiten los checks, con el mismo límite de rondas. Esto evita aprobar modificaciones con resultados anteriores; sigue sin certificar por sí solo la corrección del código.

Fuentes: [permisos de Claude Code](https://code.claude.com/docs/en/permissions) y [CLI de Codex](https://learn.chatgpt.com/docs/developer-commands?surface=cli).

## Director de solo lectura, Git y flujo ágil (0.5)

**Roles.** El director (Codex) inspecciona y decide; nunca escribe. Sus invocaciones usan siempre `--sandbox read-only` (o `-c sandbox_mode="read-only"` al retomar), incluso con acceso completo, y su prompt lo dice. El ejecutor (Claude) escribe todo el código. Una tarea del chat dirigida al director es un relevo: el director responde con instrucciones y a continuación el ejecutor las aplica; si el director falla, el ejecutor no corre. Se conserva la vigilancia de archivos durante la revisión como red de seguridad: si algo cambia, no se aprueba con verificaciones anteriores.

**Git decidido por el director.** Cada decisión incluye un objeto `git` (`commit`, `message`, `push`, `branch`, `merge_into`) en el esquema de revisión. `server/git.mjs` lo normaliza (nombres de rama validados, mensajes acotados) y lo ejecuta con operaciones deliberadamente estrechas: `add -A -- .` limitado a la carpeta del proyecto, exclusión de archivos con secretos (`.env`, claves, credenciales), `switch`, `push -u origin <rama>` sin forzar, y `merge --no-ff` que se cancela y vuelve a la rama original si hay conflictos o cambios sin confirmar. Nunca reescribe historial ni borra ramas. Los comandos se muestran en la terminal del ejecutor. El ajuste `gitMode` decide qué espera aprobación: `ask-push` (por defecto, el commit es automático; push y merge se aprueban desde la tarjeta «El director propone»), `ask-all`, `auto` u `off`. Las operaciones pendientes se guardan en la ejecución (`gitQueue`) y se resuelven con `POST /api/git`; el push puede aprobarse mientras el ejecutor trabaja, el resto espera a que esté libre.

**Repositorios por proyecto.** La «carpeta de proyectos» (`projectsRoot`) agrupa un repositorio por carpeta. «Repositorio nuevo» crea la carpeta (nombre seguro, con sufijo si está ocupada), ejecuta `git init -b main`, un README y el commit inicial, y opcionalmente `gh repo create --private --push`. Clonar sin elegir carpeta usa `<carpeta de proyectos>/<repositorio>`.

**Flujo más ágil.** Los agentes retoman su sesión entre rondas (`claude --resume`, `codex exec resume`) con prompts cortos; si una sesión no se puede retomar y aún no hizo nada, se reintenta con el prompt completo. Si fallan las verificaciones, el ejecutor corrige directamente con la salida de las verificaciones (hasta 3 veces seguidas) sin esperar al director; una instrucción del usuario vuelve a pasar por el director. Los eventos se guardan agrupados y la vista del ejecutor muestra comandos, diffs y código como una terminal, con su salida en vivo.

## El director observa y pregunta antes de correr la app

**Bitácora del codificador.** Mientras Claude trabaja (en el ciclo o en una tarea del chat durante un trabajo), `server/watch.mjs` registra en la ejecución (`run.watch`) lo que lee, escribe y edita, con sus diffs, y los comandos que corre con su resultado. En la siguiente revisión el director recibe ese resumen («LO QUE VISTE HACER AL CODIFICADOR…», con un tope de tamaño; los diffs más recientes primero) y la instrucción de no releer todo el proyecto: parte de la bitácora y del diff y abre solo lo que necesite para confirmar. Lo ya revisado se descarta. La copia queda en `round-NN/watch.txt`. La interfaz muestra al director «Observando» mientras el codificador trabaja. El director sigue siendo un solo proceso que no corre en paralelo: Automata observa por él y se lo entrega al revisar, para no gastar tokens ni chocar con el codificador.

**¿Correr la app?** El esquema de revisión incluye `run` (`ready`, `command`, `url`, `note`). Cuando el director indica que ya hay algo que abrir, Automata pregunta en la barra «El director propone» con **Correr / Ahora no**: una vez por comando a mitad del trabajo, y otra al completar el objetivo. Nada se ejecuta sin aprobación. `normalizeRun` acepta solo un comando de una línea y direcciones locales (`localhost`, `127.0.0.1`). `server/apprun.mjs` corre una app a la vez en la carpeta del proyecto (PowerShell `-EncodedCommand` en Windows), guarda las últimas líneas de su salida, detecta la dirección local si aparece y la detiene con su árbol de procesos al pulsar **Detener** o al cerrar Automata. En escritorio, **Abrir** solo permite direcciones locales además de https. API: `POST /api/app` con `{runId, offerId, decision}` o `{action: "stop" | "dismiss"}`.

## Planes en vez de claves de API, cuentas y estados

**Solo el plan.** `settings.planOnly` (activado por defecto) hace que Claude y Codex usen la suscripción con la que el usuario inició sesión en sus CLI, igual que en la terminal. Con una clave de API en el entorno las CLI cobran por uso, así que `agentEnv` deja fuera `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` para Claude y `OPENAI_API_KEY`/`CODEX_API_KEY` para Codex en trabajos, consultas, comprobaciones de estado y logins (Node omite las variables con valor `undefined`). No se modifican las variables de Windows. Cuentas indica qué claves encontró y que no se usan.

**Cuentas.** Cada tarjeta muestra con qué se conectó (plan y correo de Claude, plan de ChatGPT, usuario de GitHub; nunca tokens) y ofrece **Cambiar cuenta** (el login oficial de la CLI) y **Cerrar sesión** (`claude auth logout`, `codex logout`, `gh auth logout --hostname github.com --user …`), con confirmación porque la sesión es de toda la PC. Las tarjetas de Claude y Codex incluyen el selector de modelo, el mismo de cada panel.

**Estados.** Cada panel muestra Trabajando (con reloj), Observando, Verificando, Esperando, Pausando / Pausa pedida, En pausa, Completado, Necesita tu decisión, Error o Interrumpido. El subtítulo pasa a ser la actividad en curso (por ejemplo «Editando src/app.js») y una barra recorre el borde superior mientras trabaja; en pausa queda en ámbar.

## Memoria del proyecto

**Almacenamiento.** `server/memory.mjs` guarda lo que Claude y Codex deben recordar de cada proyecto:
- Cada proyecto tiene **un archivo SQLite propio** (`node:sqlite`, el que trae el Node de Electron, con FTS5) en `<datos>/memory/<id del proyecto>.db`, fuera de la carpeta del proyecto. El archivo guarda el id de su proyecto y se rechaza si se copia a otro, así que no hay consultas entre proyectos.
- El archivo se abre solo durante cada operación: no hay procesos residentes, puertos ni archivos bloqueados.
- Cada escritura es una transacción con `synchronous = FULL`, así que la memoria sobrevive a cierres e interrupciones.

**Qué guarda.** Solo resúmenes, cada uno con el trabajo y la ronda de origen. El historial completo sigue en `runs/<id>/round-NN/`. Tablas:
- `facts`: recuerdos de tipo decisión, entorno, avance, pendiente, trampa conocida o nota, con estado activo o retirado. Las correcciones quedan en `fact_revisions`.
- `errors`: firma, comando, extracto y número de veces que apareció.
- `solutions`: la ronda, los archivos cambiados y el resumen que dejaron pasar la verificación otra vez.

**Captura** (sin hooks; solo lo que el coordinador ya ve):
1. **Verificaciones** (`recordChecks`). Una verificación que falla abre un error con su firma: comando y primera línea de error, sin tiempos, rutas absolutas ni números. Cuando la misma verificación pasa, sus errores abiertos se resuelven con los archivos editados según la bitácora y el reporte de Claude.
2. **Comandos de Claude** (`recordCommands`). En cada llamada, un comando de compilación o prueba que falla y luego funciona queda resuelto con lo que cambió en medio.
3. **Revisión del director.** El esquema tiene `memory.add` (hechos duraderos) y `memory.retire` (ids que el director comprobó falsos). Además, el resumen de cada revisión se guarda como avance, y los criterios abiertos quedan como pendientes automáticos, que se retiran al cumplirse.
4. **Reportes de Claude y respuestas del chat.** Si terminan con una sección «PARA RECORDAR:», se guarda una línea por hecho con su etiqueta.
5. **Commits** que ejecuta Automata, como avances.

**Recuperación.** `brief()` arma el bloque «MEMORIA DEL PROYECTO» para los prompts del director (completo y corto), de Claude (completo y corto) y del chat:
- Se limita a 1 500 tokens, estimados como 4 caracteres por token y repartidos por secciones con `allocateBudget`.
- Orden de prioridad:
  1. soluciones conocidas para las verificaciones que fallan ahora (la misma firma o una parecida, buscada con FTS),
  2. entorno,
  3. decisiones,
  4. pendientes,
  5. trampas conocidas,
  6. errores resueltos antes,
  7. avances recientes,
  8. notas.
- Dentro de cada sección va primero lo relevante a la tarea actual (FTS sobre su texto).
- El bloque que recibió cada agente queda en `round-NN/memory-plan.txt`, `memory-code.txt` o `memory-review.txt`.

**Corregir.** El panel Memoria (barra lateral) y `POST /api/memory` permiten consultar, buscar, agregar, corregir, retirar y restaurar recuerdos, y retirar errores. Lo retirado deja de llegar a los agentes.

**Secretos.** `server/redact.mjs` limpia todo antes de guardarlo:
- formas de token, asignaciones (`password=`, `"api_key": …`), bloques de clave privada, contraseñas en URL y cadenas aleatorias de alta entropía;
- los archivos sensibles no se guardan como parte de una solución.

Desde esta versión, el registro original de cada llamada (`*.jsonl`) también se limpia línea por línea sin romper el JSON, igual que los eventos, los reportes y la salida de las verificaciones. La redacción, el saneamiento FTS y el reparto de presupuesto están adaptados de local-mem (MIT); el aviso está en `server/redact.mjs` y en `THIRD_PARTY_NOTICES.md`.

**Tolerancia a fallos.** Si la memoria falla (disco lleno, archivo dañado), se muestra un aviso una vez y el trabajo continúa sin ella.

## Recuperación autónoma (P1)

**Clasificación.** `server/recovery.mjs` convierte cualquier fallo de una llamada a Claude o Codex en un veredicto: `limit` (límite de uso o de tasa, con la hora de restablecimiento si la CLI la dio en el texto, en `rate_limit_event` o en el error de Codex), `transient` (red, 5xx, sobrecarga, flujo cortado, tiempo de llamada agotado, proceso que termina sin explicación), `context` (la sesión creció demasiado: se abre una nueva con el prompt completo), `malformed` (JSON inválido, respuesta vacía o una revisión que no cumple las reglas de aprobación), `turns` (Claude agotó sus turnos), `fatal` (cuentas, instalación, modelo inexistente, errores internos) y `aborted`. El adaptador (`agents.mjs`) añade al error lo que hace falta para decidir: `role`, `exitCode`, `subtype` del resultado, `rateLimit`, el último mensaje y si el agente llegó a trabajar (`progressed`).

**Política de espera** (`planWait`), siempre acotada:
- límite con hora confiable: esperar hasta esa hora más un minuto; una hora pasada o a más de 24 h no se confía;
- límite sin hora: 5, 15, 30 y luego 60 minutos, hasta 8 esperas por etapa (unas 6 h);
- fallo pasajero: 30 s, 2, 5 y 10 min, hasta `maxRetries` por etapa (4 por defecto, 0 a 10);
- tope global de 40 esperas por trabajo. Al superar un tope el trabajo queda en `error` con el motivo y espera a la persona.

**Estado `waiting`.** El trabajo guarda `waiting` (`kind`, `role`, `reason`, `resumeAt`, `reliable`, `attempt`, `maxAttempts`, etapa y ronda) y `resumeAt`. Un temporizador comprueba cada minuto como máximo, así que una PC que durmió reanuda al despertar. La etapa pendiente no cambia: al reanudar se repite solo esa etapa. Si Claude ya había trabajado, la ronda conserva su número y su sesión, y la tarea llega con la nota de continuar sin repetir lo hecho. **Pausar** durante la espera cancela la cita y deja el trabajo en pausa; **Detener** lo detiene; **Continuar ahora** salta la espera. Un trabajo detenido o pausado a propósito nunca se reanuda solo.

**Revisión inválida.** El director recibe hasta `MAX_REVIEW_FIXES` (3) peticiones de corrección en la misma sesión, con el motivo exacto (JSON inválido, sin siguiente tarea, aprobación sin evidencia, aprobación con verificaciones fallidas…). A la tercera fallida el trabajo queda en `error`. Si faltan las verificaciones de la ronda, no es culpa del director: se ejecutan una vez y se le vuelve a preguntar.

**Turnos y tiempo.** Si Claude agota sus turnos o el tiempo de la llamada después de hacer trabajo, el reporte parcial (su último mensaje más una nota de Automata) pasa a las verificaciones y al director, en vez de repetir la tarea.

**No repetir lo que ya se hizo.** Cada llamada a un agente tiene un `attemptId` guardado en `run.inflight` (o `message.inflight` en el chat). El adaptador escribe `<fase>-result.json` con ese id solo cuando la llamada terminó bien. Al abrir Automata, una operación que estaba en vuelo y cuyo resultado existe se reutiliza sin volver a llamar al agente. La revisión del director se guarda y la etapa pasa a `apply` **antes** de ejecutar Git u ofrecer correr la app, así un cierre en medio de esa aplicación no vuelve a pedir la revisión; la cola de Git descarta decisiones repetidas de la misma ronda. Una operación de Git que estaba ejecutándose al cerrar queda como `uncertain`: nunca se repite sola; la barra del director ofrece **Repetir** o **Descartar**. Lo mismo vale para cualquier acción externa: nada con resultado incierto se reintenta automáticamente.

**Al abrir Automata** (`restoreRuns`, `restoreMessages`, `startAutoResume`): un trabajo que estaba corriendo, en espera o cortado por el cierre de la app (`interruptedBy: "close"`, distinto de Detener) se marca y, si `autoResume` está activo, continúa solo al poco de arrancar el servidor, después de comprobar las cuentas igual que **Continuar**. Si las cuentas no están listas, espera 5 minutos más sin gastar intentos. Un mensaje del chat que estaba en proceso se reencola una sola vez, conservando las respuestas que ya tenía; una segunda interrupción lo deja marcado para la persona. Con `autoResume` desactivado todo queda como «Interrumpido» hasta pulsar Continuar.

**Memoria.** Cada interrupción, espera, reintento, corrección del director y rendición queda como recuerdo de tipo `recovery` (lo escribe Automata, nunca los agentes), visible en el panel Memoria y, en tres líneas como máximo, al final del bloque de memoria de los prompts. Además, los recuerdos que mencionan archivos que ya no existen en el proyecto se marcan (`stale`) en el panel y en los prompts («⚠ ya no existe»), sin retirarlos: la decisión es de la persona o del director.

**Escritorio.** `autoStart` (desactivado por defecto) registra o quita Automata en el inicio de sesión de Windows con `app.setLoginItemSettings`, solo en la app empaquetada y solo cuando la persona cambia la opción. No se toca ninguna otra configuración global.

**Auditoría de registros.** `node scripts/audit-secrets.mjs [carpeta de datos] [--quarantine]` revisa los registros históricos (`*.jsonl`, prompts, reportes, eventos, mensajes y las bases de memoria) en busca de secretos. Sin opciones solo informa. Con `--quarantine` mueve cada original a `quarantine/<fecha>/` con permisos de solo dueño, verifica que la copia redactada siga siendo JSON válido y deja un manifiesto con el SHA-256 de ambas versiones.

## Plan persistente y memoria conversacional (P2)

**Tareas.** `server/plan.mjs` guarda el plan en el mismo archivo SQLite del proyecto (esquema 2: `tasks`, `task_history`, `plan_applied`). Una tarea tiene título, detalle, criterio (texto exacto de un criterio de aceptación, o vacío si es de apoyo), estado (`todo`, `doing`, `review`, `done`, `blocked`, `dropped`), dependencias, evidencia, nota, origen (`director` o `user`) y la ronda en que se creó y se cerró. Nada se borra: cada cambio deja una fila de historial. El plan es del proyecto, no del trabajo: un trabajo nuevo lo continúa.

**El director lo mantiene.** La revisión trae `plan.add`, `plan.update` y `task` (la tarea que asigna con `nextPrompt`: `T12` existente o `N1` recién creada). Al planificar debe cubrir cada criterio con al menos una tarea. Todo se valida en una transacción antes de aplicarse: referencias, criterios, transiciones de estado, evidencia para `done`, motivo para `blocked` y `dropped`, ciclos de dependencias, dependencias abiertas de una tarea en curso, y las reglas de la decisión (`continue` exige una tarea asignable; `complete` exige que ninguna tarea ligada a un criterio siga abierta y que cada criterio con tareas tenga al menos una hecha: descartar no cumple). Una decisión inválida se revierte entera y vuelve al director con el motivo por el bucle de tres correcciones de P1. Cada decisión se aplica una sola vez (`plan_applied` con la clave trabajo:ronda:fase), así que un reinicio que reutilice la revisión no la aplica dos veces. Automata marca `doing` la tarea asignada al enviarla a Claude.

**En los prompts** (`plan.brief`): bloque «PLAN DEL PROYECTO» con presupuesto propio de 800 tokens, aparte de los 1 500 de la memoria: la tarea actual completa, las en curso, las por confirmar, las pedidas por el usuario, las bloqueadas, las siguientes por título y las hechas por id. Claude recibe la suya como «TU TAREA AHORA» y las demás como «no las hagas ahora». El bloque queda en `round-NN/plan-<fase>.txt`. Las revisiones sin campo `plan` (agentes simulados, revisiones anteriores) no tocan el plan.

**Sesiones largas.** `coderRefreshRounds` (Claude, 8 por defecto) y `auditorRefreshRounds` (Codex, 3 por defecto) son independientes; 0 desactiva la renovación de ese agente. En un punto seguro (el inicio de una etapa, nunca en una corrección ni en una continuación), una sesión que ya sirvió N rondas se reemplaza por una nueva con el prompt completo, que trae plan y memoria. Cada renovación queda en `run.sessionLog` (con las llamadas y el contexto máximo que alcanzó la sesión que se cierra) y como evento. Los ajustes guardados con el número único anterior (`sessionRefreshRounds`) se leen así: el valor antiguo por defecto (8) cede a los nuevos; otro valor elegido se aplica a ambos.

**Consumo y contexto** (`server/usage.mjs`). Las dos CLI reportan totales que no son el contexto: el `result.usage` de Claude suma todas las solicitudes de la llamada y el `turn.completed.usage` de Codex es el acumulado de todo su hilo. Automata mide aparte (1) el **contexto**, que es la solicitud más grande de la llamada: en Claude, de `message.usage` de cada evento `assistant` (sin repetir bloques ni contar sub-agentes); en Codex, de los `token_count` (`last_token_usage`) del archivo de sesión de Codex en `~/.codex/sessions`, que solo se lee; y (2) lo **consumido** por llamada, que en Codex es la diferencia con el acumulado anterior del mismo hilo. `run.usageLog` guarda por llamada la sesión, la entrada, la caché, la salida, el contexto, la ventana del modelo y si el contexto fue medido; `usage` en el estado resume por agente llamadas, sesiones, tokens y contexto máximo, último y promedio. Un agente simulado que no mide el contexto cae a «todo lo que leyó la llamada», que lo sobrestima.

**Conversación por proyecto.** `chat_sessions` guarda la sesión retomable de cada agente; `conversations` un resumen de cada intercambio (tipo, petición, respuesta, archivos tocados). Una consulta o tarea retoma la sesión del agente con un prompt corto; «Nueva conversación» (`POST /api/chat` con `action: reset`) la reinicia y la siguiente sesión recibe los últimos cinco intercambios resumidos (400 tokens). El director recibe en cada revisión las peticiones del usuario desde su última revisión. Tipos: una **consulta** es de solo lectura y no toca el plan; una **tarea directa** que Claude ejecutó entra al plan como tarea del usuario «por confirmar» hasta que el director la confirme con evidencia o la devuelva; una **instrucción** entra al plan como tarea del usuario pendiente que el director asigna o descarta con motivo. Un mensaje casual («buen trabajo», «gracias») lo responde Automata sin llamar a ningún agente (`server/chat.mjs`). Las conversaciones viven en el archivo del proyecto: no se cruzan.

**Panel Plan** (`POST /api/plan`): ver por estado, agregar (ligada a un criterio o libre), corregir, reordenar, descartar con motivo y restaurar, con historial. El contador «PLAN hechas/activas» acompaña a la ronda.

## De una idea a un proyecto (P3)

**Carpetas seguras** (`server/safety.mjs`). Claude trabaja con permisos sobre la carpeta del proyecto, así que la carpeta tiene que ser solo suya. Se rechazan, al registrar y otra vez al iniciar (también proyectos registrados antes de esta regla): la raíz del disco; Automata o una carpeta que la contenga; los datos de Automata; Windows, Archivos de programa, `AppData`, `ProgramData` y carpetas privadas (`.ssh`, `.claude`, `.codex`…) con todo su contenido; el usuario entero y sus carpetas principales (Escritorio, Documentos, Descargas…) como tales, aunque una subcarpeta sí vale; la carpeta de proyectos misma; y cualquier carpeta que contenga otros repositorios Git hasta tres niveles (sin contar `node_modules`). Las subcarpetas de la carpeta temporal se permiten. La demostración no aplica estas reglas porque su proyecto vive dentro de los datos de Automata.

**Propuesta.** «Nueva idea» envía la frase al director en una fase `define`: Codex de solo lectura, en una carpeta vacía de borrador, con el esquema `PROPOSAL_SCHEMA` (nombre, resumen, objetivo, funciones, criterios, verificaciones, plataforma, plan con dependencias `N1…`, riesgos y preguntas). `validateProposal` exige al menos 3 criterios, una verificación, un plan de 3 tareas o más que cubra cada criterio con su texto exacto y dependencias válidas; lo inválido vuelve al director hasta 3 veces. La persona puede ajustar (la propuesta anterior viaja con el pedido) o descartar. Un mensaje casual no inicia nada. Mientras se prepara, el coordinador está ocupado (una sola operación de agente a la vez).

**Una sola aprobación.** «Crear y empezar» crea la carpeta con `git init` y un commit inicial (`github.createNew`, sin repositorio remoto), registra el proyecto con las reglas de carpeta, siembra el plan aprobado (`plan.apply` con la clave `proposal:<id>`), guarda en la memoria la plataforma y las limitaciones aceptadas, e inicia el trabajo. Las restricciones del proyecto prohíben publicar, comprar, crear cuentas, push y merge, y afirmar calidad comercial. Push y merge siguen pasando por la barra de aprobaciones (`ask-push`). Al planificar sobre un plan existente, el director recibe la instrucción de no repetirlo.

**Archivos para Claude.** La revisión trae `files`: hasta 12 rutas relativas que Claude debe abrir primero (normalizadas: nada absoluto, nada con `..`). El prompt de Claude las lista como «ARCHIVOS RELEVANTES PARA ESTA TAREA». `usageLog` registra cuántas recibió cada llamada.

**Experiencia.** La propuesta se muestra en lenguaje sencillo (qué hará, cómo se comprobará, dónde se usará, pasos con sus dependencias, qué tener en cuenta, dónde se guardará); los comandos quedan en «Detalles técnicos». La línea de estado dice qué se está construyendo y cuántas tareas faltan. Las tareas directas del chat se confirman o se devuelven desde el panel Plan. Reordenar tareas deja historial.

## Estabilización de P3

**Citas de criterios en la propuesta** (`resolveQuote` en `config.mjs`). Una tarea cita un criterio con su texto; antes solo valía el texto exacto. Ahora se resuelven sin pedir otra propuesta: el mismo texto con otras mayúsculas, acentos o puntuación, una cita cortada que abre un solo criterio, un criterio con texto alrededor, un trozo de un criterio y varios criterios pegados en una cita (la tarea queda ligada al primero y cada otro criterio sin tarea propia recibe una tarea «Comprobar: …» al final del plan, que el director cierra con su evidencia). Se rechazan las citas que encajan con varios criterios (ambiguas) o con ninguno, y los criterios que ninguna tarea menciona; el mensaje trae cada criterio completo. `proposal.attempts` guarda cuántas veces se le pidió al director y `proposal.draft.adjusted` qué referencias se resolvieron. Los datos reales de Codex que motivaron esto están en `test/fixtures/real-proposals.json`.

**Cierre con cambios sin guardar** (`settleChanges` en `coordinator.mjs`). Un trabajo no llega a `complete` con cambios pendientes en Git que nadie decidió. (1) Si el director aprueba con la carpeta sucia y sin commit, se le devuelve la revisión una vez. (2) En la etapa `apply`, después de ejecutar su decisión de Git, si la carpeta sigue sucia (commit rechazado por un hook, fallido, pendiente de aprobación o no pedido) el trabajo queda `blocked` con un commit «de cierre» (`gate: true`) en la barra de aprobaciones: **Guardar** lo ejecuta, **Reintentar** repite uno fallido (con el error de Git a la vista) y **Dejar sin guardar** es la decisión explícita, que se anota en eventos y memoria. Al resolver, el trabajo termina solo. Los archivos sensibles (`.env`, claves…) nunca se confirman: se avisan y no bloquean. Con `gitMode: off` no se pregunta. `run.gitProblem` recuerda el último commit fallido y el director lo ve en su regla de Git. En proyectos creados desde una idea, push y merge esperan siempre la aprobación de la persona, también en modo `auto`.

**Procesos hijos** (`server/procs.mjs`). Cada agente y cada verificación se registra en `children.json` (carpeta de datos) con el momento en que empezó. Al terminar su llamada se cierra lo que dejó corriendo (por ejemplo un servidor de pruebas en segundo plano): solo los descendientes creados mientras vivía, así que un id reutilizado nunca coincide. Al abrir Automata, `sweepOrphans` cierra los hijos de una sesión anterior cerrada a la fuerza, pero solo si el id, el momento de inicio y el programa coinciden, y nunca al propio proceso ni a los del sistema. Cada cierre queda como evento visible. No se registran ni limpian los comandos `git`, que son breves.

**Recursos y presupuesto de memoria** (`server/resources.mjs`). Solo lee; nunca cierra, pausa ni modifica un proceso. Mide por separado tres cosas: la memoria libre del sistema, el margen de memoria virtual (commit) de Windows —no son lo mismo: hay PC con RAM libre y sin margen— y lo que usa el árbol propio de Automata (el proceso de Automata y todo lo que lanzó: Claude, Codex, verificaciones y la app que corre), sumando su memoria física; el entrenamiento de otro programa o las sesiones de Claude del usuario no son descendientes y no cuentan. `ramBudgetMB` (Ajustes; valor inicial 30 720 MB = 30 GiB o `AUTOMATA_RAM_BUDGET_MB`; 0 lo apaga y deja de medir el árbol) es el tope de ese árbol. Antes de preparar una propuesta, aceptarla, iniciar o continuar un trabajo, enviar una consulta a un agente, abrir cada agente y ejecutar las verificaciones se comprueba: (1) que el sistema conserve al menos 1 536 MB libres y 2 048 MB de margen (`AUTOMATA_MIN_FREE_MB`, `AUTOMATA_MIN_COMMIT_MB`; 0 apaga cada una) para Windows y otros programas, y (2) que el árbol propio más 1 024 MB de reserva para el siguiente proceso quepa en el presupuesto. Desde el 85 % del presupuesto el estado es «cerca»; por encima, «excedido». La API responde con el motivo y, dentro de un trabajo, este queda `waiting` («Poca memoria libre en la PC») y reintenta con la espera de P1, con el plan, la memoria y lo hecho intactos. Mientras un trabajo corre, cada 20 s se vuelve a medir y `run.memory` guarda los extremos de la ejecución (máximo del árbol, de Claude y de Codex, mínimo de memoria libre y de margen, muestras y cuántas veces estuvo excedido); cruzar a «cerca» o «excedido» se avisa una vez. **No es un límite duro**: Automata no inicia nada que no quepa, pero un proceso ya en marcha que supere el presupuesto se deja terminar y solo se avisa.

## Idiomas y configuración (0.4.0)

`settings.language` acepta `es` o `en`. El coordinador persiste la elección y la comparte por eventos con Windows y Android. Los prompts solicitan las próximas respuestas en ese idioma y conservan literalmente los criterios de aceptación. Las llamadas ya iniciadas conservan su snapshot. La interfaz recuerda el idioma localmente incluso antes de conectarse; el coordinador es la fuente de la preferencia al establecer conexión.

`public/i18n.js` traduce los textos de interfaz y atributos accesibles. No traduce mensajes del usuario, nombres de proyecto, rutas, criterios ni respuestas históricas. Configuración reúne los controles de idioma, permisos, modelos con identificadores personalizados, razonamiento, ritmo y límites; también permite abrir cuentas y conexión. Las opciones de razonamiento se recalculan cuando cambia el modelo.

## Fuentes utilizadas

- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/models
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/model-config
- https://www.electronjs.org/docs/latest/tutorial/security
- https://developer.android.com/develop/ui/views/layout/webapps/webview
- https://developer.android.com/tools/aapt2
