# P2 · Plan persistente y memoria conversacional: reporte

Fecha: 27 oct 2026 · Rama: `feature/p2-persistent-plan` (a partir de `357e6da`, la P1 publicada) · Sin push ni merge.

## Veredicto

P2 está implementado, probado con agentes simulados, con Chrome y con un ciclo real de Claude y Codex de 11 rondas que incluyó un plan de 8 tareas con dependencias, 9 renovaciones de sesión, un corte forzado a mitad de ronda con el plan recuperado intacto y una conversación encadenada con el director. La única intervención humana fue Iniciar. El ciclo real encontró un defecto (un saludo con signo de exclamación inicial sí llegó a los agentes); está corregido y comprobado contra los mismos datos.

| Commit | Contenido |
|---|---|
| `b0d7696` | `server/plan.mjs`, `server/chat.mjs`, esquema 2 de la memoria, director con plan, renovación de sesiones, memoria conversacional, API |
| `732c08a` | Panel Plan, contador PLAN, Nueva conversación, ajuste de renovación, documentación y simulacros |
| *(este commit)* | Corrección del mensaje casual con puntuación inicial y este reporte |

---

## 1. Funcionalidades implementadas

| Componente | Dónde | Qué hace |
|---|---|---|
| **Tareas persistentes con historial y dependencias** | `server/plan.mjs`; tablas `tasks`, `task_history`, `plan_applied` en el SQLite de cada proyecto (`memory.mjs`, esquema 2) | Tarea = título, detalle, criterio (texto exacto de un criterio o vacío), estado `todo/doing/review/done/blocked/dropped`, dependencias, evidencia, nota, origen (`director`/`user`), ronda de creación y cierre. Ids estables; nada se borra: cada cambio deja una fila de historial. El plan es del proyecto: un trabajo nuevo lo continúa. Tope de 120 tareas y 40 por decisión. |
| **Plan actualizado y validado por el director** | `config.mjs` (`REVIEW_SCHEMA.plan`, `task`), `coordinator.mjs` (`applyPlanDecision`, `review`), `plan.mjs` (`apply`, `planProblem`) | La revisión trae `plan.add`, `plan.update` y `task` (`T12` existente o `N1` recién creada). Al planificar debe cubrir cada criterio con al menos una tarea. Todo se valida en una sola transacción y se revierte entero si falla: referencias, criterio inexistente, transiciones de estado, evidencia para `done`, motivo para `blocked`/`dropped`, ciclos, dependencias abiertas de una tarea en curso o hecha, y las reglas de la decisión. Una decisión inválida vuelve al director con el motivo por el bucle de 3 correcciones de P1. Cada decisión se aplica una vez (`plan_applied` con clave trabajo:ronda:fase, que también guarda la tarea asignada). Automata marca `doing` la tarea asignada al enviarla a Claude. |
| **Contexto compacto del plan en los prompts** | `plan.mjs` (`brief`), `prompts.mjs` (`planSection`) | Bloque «PLAN DEL PROYECTO» con presupuesto propio de 800 tokens, aparte de los 1 500 de la memoria: tarea actual completa (criterio, detalle, dependencias con ✓), en curso, por confirmar, pedidas por el usuario, bloqueadas, siguientes por título, hechas por id. Claude lo recibe como «TU TAREA AHORA» y «OTRAS TAREAS (no las hagas ahora)». Se guarda en `round-NN/plan-<fase>.txt`. El director recibe además la instrucción de no releer el proyecto cuando tiene plan, bitácora y diff. |
| **Renovación segura de sesiones largas** | `config.mjs` (`sessionRefreshRounds`, 8 por defecto, 0 desactiva), `coordinator.mjs` (`invoke`) | Solo en puntos seguros (inicio de una etapa; nunca en una corrección del director ni en la continuación de una tarea interrumpida): una sesión que ya sirvió N rondas se reemplaza por una nueva con el prompt completo, que trae plan, memoria, decisiones y errores resueltos. Cada renovación queda en `run.sessionLog` y como evento «SESIÓN». |
| **Memoria conversacional por proyecto** | `memory.mjs` (`chat_sessions`, `conversations`), `coordinator.mjs` (`drainChats`, `resetChat`), `prompts.mjs` (`chatPrompt` corto), `server/chat.mjs` | Una sesión retomable por agente y proyecto; cada intercambio se guarda resumido (tipo, petición, respuesta, archivos tocados, sin secretos). El segundo mensaje retoma la sesión con un prompt corto; «Nueva conversación» la reinicia y la siguiente recibe los últimos 5 intercambios (400 tokens). El director recibe en cada revisión «Peticiones del usuario desde tu última revisión». Consulta: solo lectura, no toca el plan. Tarea directa: entra al plan como tarea del usuario «por confirmar» hasta que el director la confirme con evidencia o la devuelva. Instrucción: entra al plan como pendiente del usuario que el director asigna o descarta con motivo. Mensaje casual: Automata responde sin llamar a nadie. Todo vive en el archivo del proyecto: sin cruces. |
| **Panel Plan e integración con la API** | `public/`, `POST /api/plan`, `POST /api/chat` (`action: reset`), `snapshot.plans`, `desktop/main.cjs` | Panel con tareas por estado, evidencia, dependencias y origen; agregar (ligada a un criterio o libre), corregir, reordenar, descartar con motivo, restaurar, historial. Contador «PLAN hechas/activas» junto a la ronda. Botón Nueva conversación en el chat. Ajuste «Renovar sesiones cada N rondas». Español e inglés. |
| **Medición de consumo** | `coordinator.mjs` (`usageLog`, `usageSummary`) | Por llamada: ronda, agente, fase, contexto leído (entrada más caché), salida y si retomó sesión. Resumen por agente y número de renovaciones en el estado de cada trabajo. |

### Ajustes obligatorios, uno por uno

- **A. Integridad.** `complete` sigue exigiendo evidencia por criterio (`validateReview`, sin cambios) y además que ninguna tarea ligada a un criterio quede abierta y que cada criterio con tareas tenga al menos una `done`: una `dropped` no cuenta (probado). Dependencias, referencias (`T`/`N`), transiciones y ciclos se validan; los ids son estables y el historial completo; cada decisión se aplica una sola vez por clave.
- **B. Memoria y sesiones.** Renovación solo en puntos seguros; la sesión nueva recibe plan (≤ 800 tokens), memoria (≤ 1 500) y, en el chat, la conversación (≤ 400). No se envía el historial: la memoria solo guarda resúmenes y el plan va recortado por secciones. En el ciclo real el bloque del plan ocupó entre 110 y 393 tokens y la memoria entre 396 y 1 295.
- **C. Chat.** Las consultas corren en solo lectura (`plan`/`read-only`, igual que antes) y no tocan el plan. Las instrucciones entran al plan. Una tarea directa queda «por confirmar» hasta que el director la revise. Lo casual no inicia desarrollo (corregido tras el ciclo real; ver fallas). Conversaciones aisladas por proyecto (probado).
- **D. Eficiencia.** Tokens medidos por ronda y agente; renovaciones registradas; comparación abajo; el director recibe la instrucción explícita de no releer el proyecto; no hay rondas artificiales: el ciclo real necesitó 11 rondas para 8 tareas porque las verificaciones fallaron en dos de ellas y el director pidió correcciones reales.
- **E. Validación.** Los diez criterios de aceptación están cubiertos por pruebas automáticas; el ciclo real demostró continuidad durante 11 rondas sin prolongaciones impuestas por Automata.

---

## 2. Resultados de las pruebas

**Automáticas: 145 de 145** (las 133 de P1 más 12 nuevas). Ninguna prueba anterior cambió de expectativa.

`test/plan.test.mjs` (5): creación con dependencias entre nuevas y existentes, ids e historial, plan que sobrevive a reabrir el archivo e idempotencia por clave; transiciones, dependencias, ciclos, referencias, evidencia y motivo validados sin dejar rastro; cobertura de criterios y reglas de `complete`/`continue` (descartar no cumple); bloque dentro de 800 tokens con la tarea actual primero y texto adaptado a Claude; memoria conversacional (sesiones por agente, intercambios resumidos sin secretos, bloque breve, aislamiento, reinicio).

`test/plan-flow.test.mjs` (7): ciclo completo con tareas asignadas en orden, marcadas en curso y confirmadas, prompts de Claude y del director con el plan, y un trabajo nuevo que continúa el plan hecho; decisión inválida devuelta al director con el motivo sin dejar rastro y `error` a la tercera; renovación de sesiones cada 2 rondas en puntos seguros con registro, prompt completo con lo hecho, medición de contexto y desactivación con 0; cierre con la revisión entregada sin aplicar el plan dos veces y conservando la tarea asignada; conversación retomada, aislada y reiniciada con resumen; consultas, tareas directas, instrucciones y mensajes casuales; panel y API (ligada o libre, corregir, reordenar, descartar, restaurar, historial, contador, director de demostración).

**Interfaz en Chrome:** `node scripts/smoke-plan.mjs` **18 de 18** (capturas en `artifacts/smoke-plan-2026-10-27T20-51-44-111Z/`). Las pruebas anteriores siguen en verde: `smoke-waiting` 12/12, `smoke-memory` 13/13, `smoke` 13/13.

**Criterios de aceptación propuestos**

| # | Criterio | Prueba |
|---|---|---|
| 1 | Tarea de la ronda 1 presente en los prompts tras borrar las sesiones; plan ≤ 800 tokens | plan-flow (renovación: la sesión nueva recibe `HECHAS`), plan (presupuesto), ciclo real (plan-*.txt de 110 a 393 tokens) |
| 2 | El plan sobrevive a reiniciar y a un trabajo nuevo | plan (reabrir el archivo), plan-flow (trabajo nuevo con `HECHAS: T1, T2`), ciclo real (plan idéntico tras el corte) |
| 3 | Sin `complete` con tareas pendientes ni asignación con dependencias abiertas; 3 correcciones | plan-flow (decisión inválida), ciclo real (corrección «T0 no existe») |
| 4 | Dos mensajes seguidos comparten sesión | plan-flow (`resume` en la segunda consulta), ciclo real (segunda consulta `resumed: true` y respuesta que continúa la primera) |
| 5 | Consulta no cambia nada; tarea directa queda por confirmar; instrucción crea tarea | plan-flow |
| 6 | `sessionRefreshRounds = 3` abre sesiones nuevas con lo hecho | plan-flow (con 2), ciclo real (con 2: 9 renovaciones) |
| 7 | Panel: agregar, reordenar, descartar; historial conserva lo descartado | plan-flow (API), smoke-plan (Chrome) |
| 8 | Cierre en la revisión sin aplicar el plan dos veces | plan-flow, ciclo real |
| 9 | Pruebas en verde | 145/145 y 4 pruebas de interfaz |
| 10 | Ciclo real con ≥ 8 criterios, reinicio de sesión y conversación encadenada, solo Iniciar y aprobaciones de Git | ciclo real: 8 criterios, 11 rondas, 9 renovaciones, 1 intervención; el merge quedó pendiente de aprobación (`ask-push`) |

---

## 3. Evidencia de agentes reales

Proyecto aislado `C:\Users\cellh\Automata Projects\p2-agenda`: una agenda de contactos en Node (módulo, CLI con persistencia JSON, README), 8 criterios con una prueba de aceptación escrita por mí (8 casos) y una verificación de integridad por SHA-256. Claude `claude-sonnet-5-5` (razonamiento medio), Codex `gpt-6-luna`, acceso limitado, `apiKeySource: "none"` en las 11 llamadas de Claude, `sessionRefreshRounds = 2`, `maxRounds = 14`, segunda instancia del servidor con su propia carpeta de datos (`scripts/real-plan.mjs`; artefactos en `artifacts/real-plan-2026-10-27T20-52-12-249Z/`).

**Plan creado por el director en la fase de planificación** (8 tareas, una por criterio, con dependencias que él mismo decidió):

| Tarea | Depende de |
|---|---|
| T1 Crear la agenda vacía | — |
| T2 Agregar y validar contactos | T1 |
| T3 Impedir teléfonos duplicados | T2 |
| T4 Buscar contactos | T1, T2 |
| T5 Eliminar contactos | T1, T2 |
| T6 Persistir la agenda en JSON | T1, T2 |
| T7 Crear CLI para agregar y listar | T2, T5, T6 |
| T8 Añadir búsqueda, eliminación y documentación | T3, T4, T5, T7 |

**Cronología** (20:52 a 20:59, 7 minutos):

| Ronda | Qué pasó |
|---|---|
| 0–2 | Plan de 8 tareas; T1 hecha con evidencia; T2 asignada. Primera renovación de la sesión del director (ronda 2). |
| 3 | Claude trabajando en T2 con 2 acciones registradas → **servidor y Claude eliminados a la fuerza** (`taskkill /f`). Al reabrir: el plan tiene las mismas 8 tareas con los mismos estados y dependencias (`planIdentical: true`), `taskId = 2` conservado, trabajo `interrupted` → reanudado solo 2 s después (P1). |
| 3–4 | Verificaciones fallan; corrección directa; T2 hecha. |
| 5–6 | T3 y T4. En la ronda 6 el director envió `plan.update` con `id: 0` → Automata lo rechazó («la tarea T0 no existe»), la revisión se revirtió entera y el director corrigió en el segundo intento. |
| 7–10 | T5, T6, T7, T8, cada una confirmada con evidencia de inspección directa. |
| 11 | `complete`: 8 de 8 tareas hechas, 8 de 8 criterios con evidencia, 7 commits decididos por el director, merge en `main` pendiente de aprobación. |

**Comportamiento tras el reinicio:** el plan se leyó íntegro del archivo del proyecto; `plan_applied` evitó reaplicar decisiones (11 claves para 11 decisiones aplicadas); `run.recovery.log` registra el cierre y la reanudación; la memoria tiene 2 recuerdos de recuperación y 44 filas de historial de tareas.

**Verificación independiente después:** 8 de 8 pruebas de aceptación, árbol limpio, `git log` con los 7 commits del director sobre el commit inicial.

**Memoria conversacional (después del trabajo):**
- Consulta 1 («¿Cuál fue la tarea del plan que más rondas necesitó y por qué?»): sesión nueva; respondió «T8» con contexto del plan y una nota «PARA RECORDAR» sobre los acentos en PowerShell.
- Consulta 2 («¿Y qué archivos tocó esa tarea? No repitas la explicación anterior.»): **retomó la sesión** (`resumed: true`, prompt corto de 6 KB frente a 7,5 KB del completo) y respondió solo «T8 tocó `src/cli.mjs`, `README.md` y `test/cli.test.mjs`», sin repetir: la conversación se conservó.
- La tabla `conversations` guarda los intercambios resumidos y `chat_sessions` la sesión del director con 3 turnos.

---

## 4. Medición del consumo de tokens

Contexto por llamada (entrada más caché, según cada CLI). Línea base: simulacro 1 de P1 (`artifacts/real-recovery-2026-10-27T18-59-41-200Z`, mismo tipo de proyecto, sesiones retomadas sin renovar, 5 rondas).

**Director (Codex)**

| | P1 (sin renovar) | P2 (renovación cada 2 rondas) |
|---|---|---|
| Llamadas | 4 | 12 |
| Contexto por llamada | 53 694 → 102 811 → 166 904 → **245 214** (crece cada revisión) | 50 007, 83 382*, 138 473, 59 374*, 108 843, 38 712*, 59 658, 109 425, 38 965*, 90 557, 65 100*, 124 378 |
| Máximo | 245 214 | 138 473 |
| Promedio | 142 156 | 80 573 |

\* sesión nueva. El patrón es claro: tras cada renovación el contexto baja a 39 000–65 000 y vuelve a crecer solo una ronda. Sin renovación, en la ronda 5 ya leía 245 000 por revisión; con 11 rondas habría seguido subiendo.

**Codificador (Claude)**

| | P1 | P2 |
|---|---|---|
| Llamadas | 4 | 10 |
| Contexto por llamada | 116 514, 95 853, 231 287, 205 186 | 112 415, 143 648, 153 078*, 139 978, 115 935*, 92 396, 154 954*, 145 762, 278 817*, 295 905 |
| Promedio | 162 210 | 163 289 |

En Claude la renovación no reduce el contexto: una sesión nueva vuelve a leer los archivos que necesita (las lecturas son la mayor parte de su contexto, no la conversación), y las dos últimas rondas (T8, que toca CLI, pruebas y README) leyeron más. El beneficio de la renovación está en el director, que es quien acumulaba la conversación; para Claude el valor del plan es otro: cada sesión nueva arrancó directamente en su tarea sin pedir orientación.

**Tamaño de los bloques en los prompts reales:** plan 110–393 tokens (tope 800); memoria 396–1 295 (tope 1 500); prompt corto del director 2 200–4 500 tokens; prompt de Claude 1 200–2 200.

---

## 5. Limitaciones encontradas

1. **Un mensaje casual con signo inicial llegó a los agentes.** «¡Buen trabajo, jóvenes!» no coincidió con el detector porque empezaba con «¡», se trató como trabajo (Codex y Claude respondieron que no había nada que hacer, sin cambiar archivos) y creó una tarea del usuario «por confirmar» (T9) en el plan del proyecto de prueba. Corregido: la puntuación inicial se ignora; comprobado con una prueba nueva y, contra los mismos datos del simulacro, el mismo mensaje ya se responde localmente sin llamar a nadie ni crear tareas. El detector sigue siendo una lista de expresiones: un saludo que no esté en ella seguirá llegando a los agentes (que, como se vio, lo manejan sin hacer daño).
2. **El director se equivoca con los ids.** Una vez envió `id: 0`; la validación lo rechazó y lo corrigió al segundo intento. Es el comportamiento buscado, pero cada corrección cuesta una llamada.
3. **Confirmación de tareas directas.** Una tarea pedida por el chat queda «por confirmar» hasta la siguiente revisión de un trabajo. Si no hay ningún trabajo en marcha, nadie la confirma: el usuario puede marcarla desde el panel (corregir) o quedará así hasta el próximo trabajo.
4. **La renovación no abarata a Claude.** Ver la medición: su contexto son las lecturas de archivos. Reducirlo requeriría que el director le indique archivos concretos o que Claude reciba el diff previo; queda fuera de P2.
5. **Un solo ciclo real.** El plan con dependencias, las renovaciones y el corte se probaron en un proyecto de 8 criterios y 11 rondas; no en uno de 25 criterios y decenas de rondas. El contexto del director se mantuvo acotado; faltaría ver que el plan de 40 o más tareas siga cabiendo en 800 tokens con utilidad (el bloque recorta las siguientes a 8 títulos).
6. **Equipos de varios revisores.** Con dos revisores, solo el primero aplica cambios al plan (el segundo confirma); no se probó en real.
7. **Reordenar** no deja historial (solo cambia posiciones); descartar, corregir y cambiar estado sí.

---

## 6. Recomendación para la siguiente fase

P3 del roadmap: **empezar desde una idea en una carpeta segura**. Con el plan persistente ya existe el lugar donde la fase «definir» puede dejar objetivo, criterios verificables, verificaciones propuestas y las primeras tareas antes de que la persona pulse Empezar. Dos puntos de seguridad pendientes pesan más que cualquier función nueva: rechazar carpetas que contienen otros repositorios o a la propia Automata (`C:\proyectos` se aceptó como proyecto) y avisar cuando no hay comandos de verificación. Además, antes de proyectos largos conviene: dejar un proyecto mediano varias horas para observar un límite de uso real (sigue sin evidencia) y revisar si al director le conviene recibir el diff de la ronda en vez de releer archivos.
