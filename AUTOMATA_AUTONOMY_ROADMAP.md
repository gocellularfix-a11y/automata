# Automata: auditoría de autonomía y roadmap

Fecha: 26 oct 2026 · Rama: `feature/director-observa-planes` (commit `a468063`) · Versión: 0.4.0 en `package.json`.

Este diagnóstico se hizo leyendo el código del servidor y los datos guardados en esta PC (`%APPDATA%\Automata\workspace`). No se cambió código, no se instaló nada y no se ejecutaron agentes reales. La única prueba ejecutada fue `npm test`: **99 de 99 aprobadas**, todas con agentes simulados.

---

## 1. Estado real actual

### Lo más importante

1. **El ciclo automático nunca se ha corrido con agentes reales.** En esta PC, `runs.json` está vacío (`[]`). El ciclo planear → programar → verificar → revisar (`server/coordinator.mjs:390`) solo se ha probado con agentes simulados y en el modo demo.
2. **La calculadora se hizo con el chat, no con el ciclo.** El historial (`messages.json`) tiene 7 mensajes, todos de tipo «Trabajar» dirigidos al director:

   | Mensaje del usuario | Resultado | Duración |
   |---|---|---|
   | «crea una calculadora y calendario» | Error de Codex (el modelo `gpt-6.1-sol`, ya corregido) | 4 s |
   | «continua» | Director → Claude creó la app, el `.exe` y el APK | 379 s |
   | «como va el proyecto compa?» | Director → Claude trabajó otra vez | 228 s |
   | «el telefono esta conectado» | Director → Claude arregló el script de Android | 260 s |
   | «mejora la calculadora…» | **Se perdió**: Automata se cerró a mitad del mensaje | — |
   | «instala en mi telefono la nueva version» | Claude compiló e instaló con `adb` | 90 s |
   | «buen trabajo jovenes…» | Director → Claude volvió a compilar todo | 323 s |

   Fue un humano empujando cada paso. Funcionó porque Claude es capaz y la PC tiene JDK, Android SDK y `adb`, no porque Automata dirigiera el trabajo solo.
3. **El proyecto quedó registrado con la carpeta `C:\proyectos`, no `C:\proyectos\calculadorta`.** Esa carpeta contiene 23 proyectos, entre ellos el propio repositorio de Automata, y los agentes trabajaron ahí con acceso completo. El único criterio de aceptación fue «cuando ya funciones totalmente», y no había comandos de verificación. Nada de eso se rechazó al crear el proyecto.
4. **El director no recuerda nada de un mensaje a otro.** En 4 de los 6 mensajes respondidos, Codex reportó caracteres dañados que no existían: era la consola de PowerShell 5.1 mostrando UTF-8 como ANSI. Claude lo desmintió revisando los bytes cada vez, y en el siguiente mensaje el director volvía a reportarlo. Claude también tuvo que redescubrir qué JDK funciona (el 21 de Temurin) cada vez que compiló.

### Resumen en una línea

Automata hoy es un buen sistema de **desarrollo asistido**: dos agentes, permisos, Git controlado, terminal en vivo y Android como control remoto. Su ciclo autónomo existe en el código y está bien probado con simulaciones, pero **no se ha validado con agentes reales y se detiene ante cualquier error**.

---

## 2. Matriz de capacidades y evidencia

Niveles de evidencia:
- **R**: comprobado con agentes reales en uso real.
- **S**: comprobado con pruebas automáticas usando agentes simulados (`test/*.test.mjs`).
- **I**: implementado, sin prueba.
- **P**: parcial o solo documentado.
- **—**: no existe.

### Núcleo de autonomía

| Capacidad | Código | Evidencia | Nivel |
|---|---|---|---|
| Ciclo plan → código → verificaciones → revisión | `coordinator.mjs:390-512` | `core.test.mjs` («el ciclo planifica, implementa, verifica y audita»). `runs.json` vacío en uso real. | **S** |
| Aprobación solo con evidencia para cada criterio y sin fallos | `config.mjs:157-169`, `coordinator.mjs:457-458` | `core.test.mjs` | **S** |
| Corrección directa de verificaciones fallidas (3 intentos) | `coordinator.mjs:399-410` | `flow.test.mjs` | **S** |
| Retomar sesiones entre rondas (`--resume`, `exec resume`) | `coordinator.mjs:197-245`, `agents.mjs:200-212` | `flow.test.mjs`, con CLI simuladas | **S** |
| Bitácora del codificador para el director | `watch.mjs`, `coordinator.mjs:434` | `watch-run.test.mjs` | **S** |
| Varios codificadores y revisores | `config.mjs:38`, `coordinator.mjs:430-446` | `team.test.mjs` | **S** |
| Límite de rondas y continuar ampliándolo | `coordinator.mjs:483`, `:538` | `core.test.mjs` | **S** |
| Pausa en punto seguro y detener | `coordinator.mjs:182-195`, `:527-534` | `core.test.mjs`, `regressions.test.mjs` | **S** |
| Recuperación tras cierre (el trabajo queda «Interrumpido») | `coordinator.mjs:70-77` | `core.test.mjs` («al reiniciar se audita el trabajo parcial») | **S** |
| Reanudar solo después de un cierre o reinicio | — | No existe: hay que pulsar «Continuar» | **—** |
| Manejar límites de uso del plan (esperar al reinicio y seguir) | — | Ninguna coincidencia de `rate limit`, `usage limit`, `retry` ni `backoff` en `server/` | **—** |
| Reintentar si el director entrega un JSON inválido | — | `validateReview` lanza un error y el trabajo queda en «Error» | **—** |
| Plan de tareas persistente (lista de pendientes) | — | Solo existe el `nextPrompt` de la ronda actual y el último `summary` | **—** |
| Memoria del proyecto (hechos, decisiones, entorno) | — | Evidencia real: falso error de codificación repetido y JDK redescubierto | **—** |
| Generar requisitos a partir de una idea | — | El usuario escribe objetivo, criterios y comandos (`public/index.html:84-85`) | **—** |
| Entrega final con instrucciones para el usuario | — | El reporte es técnico; no hay etapa de entrega | **—** |

### Chat, agentes y cuentas

| Capacidad | Código | Evidencia | Nivel |
|---|---|---|---|
| Tarea del chat: el director decide y Claude ejecuta | `coordinator.mjs:599-623` | 6 mensajes reales respondidos; calculadora construida | **R** |
| Consulta de solo lectura | `agents.mjs:233-235` | `access.test.mjs` | **S** |
| Chat con memoria de la conversación | — | Cada mensaje abre una sesión nueva (`coordinator.mjs:610`, sin `agent.resume`) | **—** |
| Mensaje interrumpido al cerrar | `coordinator.mjs:61-65` | Real: el mensaje 5 se perdió y no se reenvió | **R** (se pierde) |
| Solo el plan, sin claves de API | `config.mjs:31-33` | `accounts-plan.test.mjs`. `docs/HANDOFF.md` reporta una llamada real con `apiKeySource: none`; no la volví a comprobar. | **S + R (según el traspaso)** |
| Estado de cuentas, login y logout | `auth.mjs` | `auth.test.mjs`; consultas reales de estado | **S**, parcialmente **R** |
| Modelos del director leídos de Codex | `models.mjs` | `models.test.mjs`; el arreglo de Sol nació de un error real | **S + R** |
| Director de solo lectura | `agents.mjs:229-231` | `flow.test.mjs`; en uso real el director respondió «no edité archivos» | **S + R** |

### Verificación, Git y la app

| Capacidad | Código | Evidencia | Nivel |
|---|---|---|---|
| Verificaciones con PowerShell, deteniéndose al primer fallo | `agents.mjs:310-350` | `regressions.test.mjs`, con PowerShell real | **S** (real en local) |
| Git decidido por el director (commit, rama, push, merge) | `git.mjs`, `coordinator.mjs:292-317` | `git.test.mjs` usa Git real en repos locales; `flow.test.mjs` simula Git. Push a GitHub real: no probado. | **S** |
| Excluir archivos con secretos del commit | `git.mjs:8-14` | `git.test.mjs` | **S** |
| «¿Correr la app?» y ejecutar la app | `coordinator.mjs:346-382`, `apprun.mjs` | `watch-run.test.mjs` y demo | **S** |
| Apps de consola que piden datos | `apprun.mjs:88` (stdin `ignore`) | Limitación conocida | **—** |
| Compilar el `.exe` y el APK de un proyecto | No es función de Automata: lo hizo Claude | Real en la calculadora, con el JDK 21 y el SDK de esta PC | **R** (depende de la PC) |
| Instalar en el teléfono | Lo hizo Claude con `adb` | Real: «Success», 7 + 5 = 12 | **R** (depende de la PC) |

### Plataformas

| Capacidad | Código | Evidencia | Nivel |
|---|---|---|---|
| App de escritorio (Electron) | `desktop/main.cjs` | En uso real hoy | **R** |
| Cliente Android (WebView) | `android/…/MainActivity.java` | Samsung SM-S938B por USB con versión 0.4.0 (`docs/VALIDATION.md`). La interfaz nueva no se probó en el teléfono. | **R** (versión anterior) |
| Android por Wi-Fi o Internet | `--lan`, solo HTTP | No probado (`docs/VALIDATION.md`) | **I** |
| Reconexión de la interfaz | `public/app.js:417-418` (cada 3 s) | Sin prueba específica | **I** |

**Documentación desactualizada:**
- `docs/VALIDATION.md` dice 41 pruebas; hoy son 99.
- `docs/ARCHITECTURE.md` se titula 0.4.0, pero describe funciones 0.5.

---

## 3. Brechas de autonomía

### 3.1 Qué pasa ante cada falla (según el código)

| Situación | Qué hace Automata hoy | ¿Sigue solo? |
|---|---|---|
| Claude termina con error, sin reporte o por límite de tiempo | `launch().catch` deja el trabajo en `error` (`coordinator.mjs:168-171`) | **No.** Hay que pulsar «Continuar» |
| Claude alcanza su máximo de turnos (20 en modo Pequeño) | Probablemente termina como error o «sin reporte final» (`agents.mjs:267-270`). No se ha verificado con la CLI real. | **No** |
| Codex falla o no entrega el JSON | Error, y el trabajo queda en `error` | **No** |
| El director aprueba sin evidencia para un criterio | `validateReview` lanza un error y el trabajo queda en `error`, en vez de pedirle que corrija | **No** |
| Se agota el límite del plan de Claude o de ChatGPT | Se trata como cualquier error; no se detecta ni se espera al reinicio del límite | **No** |
| Se alcanza `maxRounds` (6 por defecto, máximo 50) | Estado `limit` | **No.** Hay que subir el límite y continuar |
| El director decide `blocked` | Se detiene y pide intervención | **No** (correcto si de verdad falta algo) |
| Verificaciones fallidas | Claude corrige directamente hasta 3 veces y luego pasa al director | **Sí** |
| Se cierra la ventana | `window-all-closed` cierra la app y el servidor (`desktop/main.cjs:132`). Al volver a abrir, el trabajo queda «Interrumpido». | **No.** Hay que pulsar «Continuar» |
| Se reinicia la PC | Igual: no hay inicio automático ni reanudación | **No** |
| Se pierde la conexión Android | El trabajo sigue en la PC; el teléfono es solo un control remoto y se reconecta cada 3 s | **Sí** |
| Mensaje del chat a medio procesar al cerrar | Queda «interrumpido» y no se reenvía | **No.** Se pierde (evidencia real) |

### 3.2 Decisiones que todavía requieren a una persona

1. Crear el proyecto: carpeta, objetivo, **criterios verificables** y **comandos de verificación en PowerShell**. Esto es lo más difícil para alguien sin conocimientos técnicos.
2. Pulsar «Iniciar trabajo». El chat, que es lo que la gente usa, no inicia el ciclo.
3. Pulsar «Continuar» después de cada error, límite, cierre o reinicio.
4. Subir `maxRounds`.
5. Aprobar push y merge (`gitMode: ask-push`). No detiene el ciclo y es un control correcto.
6. Aprobar «Correr la app». No detiene el ciclo y es correcto.
7. Resolver un `blocked`.

Los puntos 5 y 6 son controles que conviene conservar. Los puntos 1 a 4 son las brechas de autonomía.

### 3.3 Proyectos grandes y sesiones largas

- **Contexto.** Los agentes retoman su sesión entre rondas, y Claude resume solo su conversación cuando crece. Pero lo que Automata guarda por su cuenta es poco: el último `summary`, el último reporte, la bitácora (máximo 14 000 caracteres) y el diff de Git. Si una sesión no se puede retomar, el director solo sabe lo que dice el último resumen.
- **Sin plan.** Una app de restaurante necesita decenas de tareas. Hoy el director decide solo «la siguiente», sin una lista guardada que diga qué falta y qué ya se hizo.
- **Sin Git, la evidencia se pierde.** La calculadora no es un repositorio. En ese caso la evidencia dice «sin Git» y el director tiene que releer los archivos en cada revisión, lo que cuesta más tokens a medida que el proyecto crece.
- **El tope de rondas** (máximo 50 en `config.mjs:74`) queda corto para un proyecto grande con tareas pequeñas.
- **Falsos «el director cambió archivos».** Durante cada revisión con acceso completo se vigila toda la carpeta (`coordinator.mjs:206-221`). La exclusión de `node_modules`, `.git` y `.automata` solo funciona en el primer nivel de la carpeta. Cualquier escritura durante la revisión cancela la aprobación: una app corriendo que guarda en una base de datos SQLite, un servidor de desarrollo con caché, o la carpeta `calculadorta\node_modules` cuando el proyecto es `C:\proyectos`. *Esto se deduce del código; no lo reproduje.* En el peor caso, el proyecto nunca llega a «complete».

### 3.4 Qué se puede hacer solo con las suscripciones

Todo el flujo actual usa los planes: Claude Max con `claude -p` y ChatGPT con `codex exec`, sin claves de API (`planOnly`). El límite real son las **cuotas de uso** de cada plan, que se reinician cada cierto tiempo. Para trabajar varias horas, Automata tiene que saber esperar a que el límite se reinicie y seguir. Hoy no lo hace.

### 3.5 Seguridad

- **Acceso completo:** Claude corre con `bypassPermissions` y puede hacer cualquier cosa que permita tu cuenta de Windows. Las únicas protecciones son instrucciones en el prompt («no borres trabajo existente», «no hagas push»). Las operaciones de Git de Automata son seguras (`git.mjs`: sin `--force`, sin borrar ramas), pero **un `git push --force` o un borrado que ejecute Claude por su cuenta no se bloquea**.
- **La carpeta del proyecto no se valida contra otras carpetas.** Solo se rechaza la raíz del disco. `C:\proyectos`, que contiene a Automata, se aceptó.
- **Sin comandos de verificación,** la aprobación depende solo del juicio del director.

---

## 4. Análisis de la arquitectura

### El modelo de roles es correcto

| Rol | Hoy | Veredicto |
|---|---|---|
| Codex: director y auditor de solo lectura | Sandbox `read-only` forzado incluso con acceso completo | Correcto. Separar quién decide de quién escribe evita que el auditor se apruebe a sí mismo. |
| Claude: ejecutor | Escribe, ejecuta y compila; demostró compilar e instalar un APK real | Correcto |
| Automata: coordinador | Estados, cola, Git, verificaciones y bitácora | Correcto, pero le faltan **memoria y resistencia a errores** |
| Usuario: objetivos y excepciones | Hoy también escribe criterios, verificaciones y pulsa «Continuar» | Ahí está la brecha |

### Cuellos de botella reales, por orden

1. **Un error detiene todo.** No hay distinción entre un error pasajero, un límite de uso, una respuesta mal formada o un fallo real.
2. **El estado del proyecto vive en la cabeza de los agentes.** El plan y lo aprendido están en sesiones que pueden perderse; el coordinador no los guarda.
3. **La entrada es técnica.** Criterios y comandos de PowerShell escritos a mano.
4. **No hay vida después de cerrar.** No hay reanudación automática.
5. **El chat no inicia el ciclo y no tiene memoria.** Además, el tipo de mensaje por defecto es «Trabajar» con el director (`public/index.html:72`). Por eso un «buen trabajo» costó 323 s de director más Claude recompilando todo.

No son cuellos de botella: correr un solo proceso a la vez (los agentes son lentos de todas formas), el formato JSON en disco (los volúmenes son pequeños) ni la interfaz.

### ¿Hacen falta componentes nuevos?

**No.** Todas las brechas se cierran dentro del código actual:
- **Resistencia a errores:** clasificar errores en `agents.mjs` y una política de reintento y espera en `coordinator.mjs` (`launch` y `loop`).
- **Plan y memoria:** dos campos nuevos en `REVIEW_SCHEMA` (`config.mjs:109`), guardados en la ejecución (`runs.json`) e incluidos en `prompts.mjs`.
- **Reanudación:** el arranque del coordinador ya marca los trabajos interrumpidos; falta llamar a `launch()` si el usuario lo permitió. Para el reinicio de la PC, Electron trae `app.setLoginItemSettings`, sin dependencias nuevas.
- **Idea → requisitos:** una fase `define` antes de `plan`, que usa al mismo director de solo lectura y el mismo mecanismo de `--output-schema`.

No hacen falta microservicios, bases de datos, frameworks ni agentes adicionales. Un tercer agente («analista de requisitos») no se justifica: el director ya cumple ese papel en una fase distinta.

---

## 5. Roadmap de cuatro niveles

Escala de esfuerzo: S = días, M = 1–2 semanas, L = más de 2 semanas.

### Nivel 1: desarrollo funcional asistido

| | |
|---|---|
| **Tenemos** | Casi todo: el ciclo, el chat-relevo, verificaciones, Git controlado, terminal en vivo, cuentas y Android. |
| **Falta** | **Correr el ciclo de verdad** al menos una vez. Hasta hoy, cero ejecuciones reales. |
| **Reutilizar** | Todo el código actual. |
| **Cambios** | Ninguno de código para empezar. Un proyecto pequeño en su propia carpeta, con 3 a 5 criterios verificables y `npm test` como verificación, iniciado con «Iniciar trabajo». Registrar cada falla real y cómo la reporta la CLI (máximo de turnos, límites, JSON). |
| **Validación** | 3 proyectos pequeños distintos llegan a «complete» desde «Iniciar», sin usar el chat. Cada `review.json` tiene evidencia para todos los criterios. |
| **Riesgos** | Que el `--output-schema` estricto o los 20 turnos de Claude fallen con los modelos reales. Esto es justamente lo que hay que descubrir. |

### Nivel 2: desarrollo y autocorrección con mínima supervisión

| | |
|---|---|
| **Tenemos** | Corrección directa de verificaciones (3 intentos), sesiones retomadas y bitácora. |
| **Falta** | Resistencia a errores, reanudación automática, memoria del proyecto y chat con memoria. |
| **Reutilizar** | `CliAgents.run` (ya tiene un reintento al retomar sesión), `launch().catch`, el arranque del coordinador, `runs.json`. |
| **Cambios** | Prioridades 1 y 2 de la sección 6. |
| **Validación** | Batería de fallas inyectadas con las CLI simuladas que ya usan las pruebas: límite de uso, JSON inválido, aprobación sin evidencia, máximo de turnos, cierre a mitad de ronda. En todas el trabajo debe seguir solo hasta «complete». Después, un proyecto mediano real (unos 10 criterios) termina con un cierre forzado a la mitad y ningún clic salvo aprobaciones de Git. |
| **Riesgos** | El formato real de los mensajes de límite de cada CLI puede cambiar con sus actualizaciones. Hay que detectarlos con un respaldo genérico (esperar un tiempo creciente) y no depender solo de leer el texto. |

### Nivel 3: proyectos completos autónomos, con recuperación persistente

| | |
|---|---|
| **Tenemos** | La base del Nivel 2 y los equipos de agentes. |
| **Falta** | Un plan de tareas persistente que guíe muchas rondas, un presupuesto en vez del tope de 50 rondas, Git siempre activo en proyectos nuevos, una vigilancia de cambios sin falsos positivos y controles de seguridad sobre Claude. |
| **Reutilizar** | `github.createNew` (ya crea carpeta, `git init` y primer commit), `GitOps.commit` para guardar cada hito y la bitácora para medir el avance. |
| **Cambios** | (a) El director mantiene `plan[]` con tareas ligadas a criterios; Automata lo guarda y lo muestra. (b) Un presupuesto de horas o rondas por proyecto, con pausa automática. (c) Los proyectos nuevos siempre en su propia carpeta con Git, y commit en cada hito verificado (ya es posible con `gitMode`). (d) Reemplazar la vigilancia de archivos por una comparación de `git status` antes y después de la revisión, o excluir la app en ejecución y las subcarpetas generadas. (e) Reglas de denegación para Claude (`--disallowedTools`, por ejemplo `Bash(git push --force*)`, `Bash(rm -rf*)`, `Bash(git reset --hard*)`). *Hay que verificar que se aplican junto con `bypassPermissions`* antes de confiar en ellas. |
| **Validación** | Una app de tamaño restaurante-MVP (20 a 25 criterios) trabaja de 6 a 8 horas, más de 30 rondas, sobrevive a un reinicio de la PC y a una espera por límite de uso, y termina con todas las verificaciones en verde y como máximo 2 intervenciones humanas, ambas de aprobación. |
| **Riesgos** | Las cuotas semanales de los planes pueden no alcanzar para proyectos grandes. La calidad del plan depende del director. Las sesiones muy largas pueden degradarse; el plan y la memoria guardados por Automata son la defensa. |

### Nivel 4: de la idea a la app entregable, sin conocimientos técnicos

| | |
|---|---|
| **Tenemos** | Claude ya demostró compilar el `.exe` y el APK e instalarlo, y existe la pregunta «¿Correr la app?». |
| **Falta** | Una entrada en lenguaje natural, requisitos generados, comprobación del entorno (JDK, Android SDK, `adb`), una etapa de entrega y una guía para el usuario. |
| **Reutilizar** | La fase `plan` del director, `REVIEW_SCHEMA`, el panel de propuestas («El director propone»), `AppRunner` y el selector de carpeta de proyectos. |
| **Cambios** | (a) Fase `define`: una frase del usuario produce objetivo, criterios verificables, comandos de verificación, plataforma y arquitectura; el usuario lo aprueba una sola vez. (b) Una comprobación del entorno antes de empezar («Para Android falta el JDK 21»), guardada en la memoria del proyecto. (c) Un criterio de entrega obligatorio: instalador o APK y un `COMO_USAR.md` escrito para no técnicos, y un panel «Tu app» con los archivos y los pasos. (d) Que el chat tenga memoria, se use por defecto para preguntar y ofrezca «Iniciar trabajo» cuando lo que se pide es construir. |
| **Validación** | 3 personas sin conocimientos técnicos escriben una frase cada una y reciben la app con su guía. La instalan sin ayuda y tienen que tomar como máximo 3 decisiones en todo el proceso. |
| **Riesgos** | Las herramientas de compilación son de la PC. Firmar y publicar en tiendas sigue siendo un paso humano (cuentas, pagos), y así debe ser. |

### Orden recomendado

`Validación real (N1)` → `P1 Resistencia` → `P2 Plan y memoria` → `P3 Entrada desde la idea y carpeta segura` → `Presupuesto, Git siempre activo, vigilancia sin falsos positivos y denegaciones (N3)` → `Entorno, entrega y guía (N4)`.

---

## 6. Las tres próximas prioridades

Antes de las tres hay un **Paso 0, que no es implementación**: correr el ciclo con «Iniciar trabajo» en un proyecto pequeño y bien definido, en su propia carpeta. Sin eso, P1 se diseñaría sobre suposiciones sobre cómo fallan las CLI reales. Además, es lo que generaría las muestras de mensajes de error que P1 necesita.

### P1. Que un error no detenga el trabajo

**Por qué:** es el bloqueo número uno para dejarlo solo varias horas. Hoy, cualquier falla deja el trabajo en «Error» o «Interrumpido».

**Archivos:**
- `server/agents.mjs` (`attempt`, `run`): clasificar el error como `limit` (límite de uso, con hora de reinicio si la CLI la da), `transient` (red o código ≠ 0 sin trabajo hecho), `malformed` (JSON inválido) o `fatal`.
- `server/coordinator.mjs` (`launch`, `loop`, constructor): nuevo estado `waiting` con `resumeAt`, reintentos acotados, y volver a pedir la revisión cuando `validateReview` falla, pasándole el error al director. Reanudación automática al abrir si `autoResume` está activado.
- `server/config.mjs`: ajustes `autoResume` (activado por defecto) y `maxRetries`.
- `desktop/main.cjs`: opción «Abrir al iniciar Windows» con `app.setLoginItemSettings`.
- `public/app.js`: mostrar «Esperando a que se reinicie tu límite · sigue a las 3:40».

**Criterios de aceptación:**
1. Una CLI simulada que responde con un mensaje de límite de uso deja el trabajo en `waiting` con `resumeAt`, y llegada esa hora continúa sola desde la misma etapa, sin repetir la tarea ya hecha.
2. Si el director entrega un JSON inválido o aprueba sin evidencia una vez, se le vuelve a preguntar con el error y el ciclo sigue. Si falla 3 veces seguidas, el trabajo queda en `error`.
3. Un error pasajero se reintenta con espera creciente, como máximo `maxRetries` veces.
4. Al cerrar Automata a mitad de una ronda y volver a abrirlo con `autoResume`, el trabajo continúa sin pulsar nada.
5. Un mensaje del chat interrumpido se vuelve a encolar una vez, en vez de perderse.
6. Pausar y detener siguen teniendo prioridad sobre cualquier reintento.
7. `npm test` sigue en verde, con pruebas nuevas para cada caso.

### P2. Plan y memoria del proyecto que no dependan de la sesión

**Por qué:** sin esto, los proyectos largos pierden el rumbo, y el director repite errores ya descartados (evidencia real: el falso problema de codificación cuatro veces y el JDK redescubierto).

**Archivos:**
- `server/config.mjs` (`REVIEW_SCHEMA`, `validateReview`): campos `plan` (tareas con `id`, `title`, `criterion`, `status`) y `memory` (hechos breves: «la codificación UTF-8 está bien; PowerShell 5.1 la muestra mal», «compilar Android con JDK 21 en `…`»).
- `server/coordinator.mjs`: guardar `run.plan` y una memoria por proyecto (`project.memory`, con tope de tamaño), y retomar una sesión de chat por proyecto y agente.
- `server/prompts.mjs`: incluir el plan y la memoria en `directorPrompt` (completo y corto), en `coderPrompt` y en `chatPrompt`. Indicar al director que lea los archivos como UTF-8.
- `public/app.js` y `public/index.html`: lista de tareas con su estado, la memoria visible y editable, y el botón «Nueva conversación».

**Criterios de aceptación:**
1. Un hecho guardado en la ronda 1 aparece en los prompts del director y de Claude de la ronda 5 y en los del chat, aunque se borren los identificadores de sesión (sesión que no se puede retomar).
2. El plan sobrevive a un reinicio de Automata y el director lo actualiza en cada revisión; no puede marcar `complete` con tareas de criterios pendientes.
3. Dos mensajes seguidos del chat al mismo agente comparten sesión: el segundo puede referirse al primero («¿y lo de antes?»).
4. La memoria tiene tope y no crece sin límite; el usuario puede borrar un hecho equivocado.
5. Los prompts cortos (sesión retomada) siguen siendo cortos: la memoria se agrega resumida.

### P3. Empezar desde una idea, en una carpeta segura

**Por qué:** es el mayor salto en experiencia de usuario y cierra el riesgo de seguridad más concreto encontrado (agentes con acceso completo sobre `C:\proyectos`).

**Archivos:**
- `server/config.mjs` (`validateProject`): rechazar carpetas que contienen otros repositorios, la carpeta de Automata o la carpeta de proyectos misma. Avisar si no hay comandos de verificación.
- `server/github.mjs` (`createNew`): por defecto, cada idea nueva crea `<carpeta de proyectos>/<nombre>` con `git init` y primer commit.
- `server/coordinator.mjs` y `server/prompts.mjs`: fase `define`. El director, en solo lectura, convierte la idea en objetivo, 3 a 25 criterios verificables, comandos de verificación propuestos, plataforma y arquitectura.
- `public/index.html` y `public/app.js`: un formulario de una sola caja («¿Qué quieres construir?»), una tarjeta de propuesta con «Empezar» y «Ajustar», y el chat por defecto en «Solo consultar» con un botón «Construir esto».

**Criterios de aceptación:**
1. «Construye una calculadora para Windows y Android» produce, sin más preguntas, una carpeta nueva con Git, al menos 3 criterios verificables y al menos un comando de verificación. Tras un solo «Empezar», arranca el ciclo.
2. Registrar `C:\proyectos` (que contiene otros repositorios y a Automata) se rechaza con un mensaje claro.
3. Un mensaje como «buen trabajo» en el chat no lanza trabajo con acceso completo.
4. Las pruebas existentes de proyectos locales y de GitHub siguen en verde.

---

## 7. Pruebas concretas para validar cada avance

| Avance | Prueba | Aprueba si |
|---|---|---|
| Paso 0 | Ciclo real con un proyecto pequeño (3–5 criterios y `npm test`) | Llega a `complete`; hay un `review.json` con evidencia por criterio; se anotan todas las fallas reales |
| P1 | Pruebas simuladas: límite de uso, JSON inválido, aprobación sin evidencia, máximo de turnos, cierre a mitad de ronda | En todas el trabajo termina solo; `npm test` en verde |
| P1 real | Cerrar Automata a mitad de una ronda real | Al reabrirlo continúa sin pulsar nada |
| P2 | Borrar `run.sessions` entre rondas | El siguiente prompt del director sigue teniendo el plan y la memoria |
| P2 real | Repetir el caso de la calculadora | El director no vuelve a reportar el falso problema de codificación después de que quedó en la memoria |
| P3 | Una frase en lenguaje natural | Carpeta nueva con Git, criterios y verificaciones generadas; un clic para empezar |
| P3 | Registrar `C:\proyectos` | Se rechaza |
| N3 | App tamaño MVP, de 6 a 8 horas, con un reinicio de PC y una espera por límite | Termina con todo en verde y como máximo 2 intervenciones de aprobación |
| N3 | La app corriendo escribe en su base de datos durante la revisión | La revisión aprueba sin el falso «el director cambió archivos» |
| N3 | Claude intenta `git push --force` | Se bloquea y queda registrado (si se confirma que las reglas de denegación funcionan con `bypassPermissions`) |
| N4 | 3 usuarios sin conocimientos técnicos | Reciben el instalador o el APK y la guía, lo instalan sin ayuda y toman como máximo 3 decisiones |

---

## Anexo: cómo se calculó el avance

Cada una de las 10 metas de la «Fase 3» se puntuó de 0 a 1 según la evidencia (1 = funciona y está probado con agentes reales; 0,5 = existe y está probado con simulaciones; menos si es parcial).

| Meta | Puntos | Por qué |
|---|---|---|
| 1. Interpretar la idea y generar requisitos | 0,1 | No existe; el usuario escribe los criterios |
| 2. Elegir una arquitectura proporcional | 0,3 | Los agentes lo hacen bien (Electron + Capacitor), pero no es un paso del sistema |
| 3. Dividir en tareas verificables | 0,4 | Una tarea por ronda, sin plan guardado |
| 4. Implementar progresivamente | 0,5 | El ciclo existe y está probado con simulaciones; nunca corrió de verdad |
| 5. Probar y corregir | 0,5 | Verificaciones y 3 correcciones directas, pero los comandos los escribe el usuario |
| 6. Mantener contexto en sesiones largas | 0,3 | Sesiones retomadas; sin plan ni memoria propios; chat sin memoria |
| 7. Recuperarse de cierres y errores | 0,3 | Guarda el estado, pero no reanuda solo ni maneja límites |
| 8. No preguntar de más y seguir con seguridad | 0,3 | Se detiene ante cualquier error; la seguridad depende del prompt |
| 9. Versiones que el usuario pueda probar | 0,5 | «¿Correr la app?» existe; `.exe` y APK reales, pero hechos por Claude en el chat |
| 10. Entrega con instrucciones para no técnicos | 0,1 | No existe |
| **Total** | **3,3 de 10** | **≈ 33 %** |

Por nivel: Nivel 1 ≈ 80 % (falta la validación real), Nivel 2 ≈ 35 %, Nivel 3 ≈ 15 %, Nivel 4 ≈ 5 %.
