# P3 · Estabilización: reporte

Fecha: 27 oct 2026, actualizado el 28 oct (validación final en la sección 6) · Rama: `feature/p3-idea-to-project` (sobre `868d2dc`) · Sin push, sin merge, sin P4.

## Veredicto

**P3 queda validado y listo para tu aprobación; no hice push ni merge ni empecé P4.** Con agentes reales, el ciclo completo (idea → propuesta → una aprobación → construcción → `complete`) se ejecutó dos veces el 28 oct (4 y 12 rondas, 8/8 y 9/9 tareas, 7 y 2 commits locales hechos por el flujo de Automata, árbol limpio, sin procesos residuales). La validación final (sección 6) añadió: las dos calculadoras entregadas abiertas en Chrome y usadas de verdad, 12 pruebas de interfaz en Chrome (incluida una nueva para los botones de Git), `npm test` en 195 de 195, la prueba de las correcciones del script de ensayo y la corrección del merge de `main` hacia `main`. La primera corrida del 27 oct (detenida por el arnés por memoria crítica) queda como antecedente.

**Fallos y límites que siguen** (detalle en la sección 6.7): una de las calculadoras no avisa con importe 0 ni con propina inválida (no lo exigía su lista de criterios); el script de ensayo se refactorizó y **no se volvió a ejecutar de punta a punta** con agentes; no se ejecutaron `smoke-phone` (necesita un teléfono Android por adb), `smoke-desktop`, `smoke-recovery` y `smoke-console` (Electron y el `.exe` empaquetado); el cierre con Git sucio en vivo y el recordatorio al director solo se probaron con director simulado, porque en los ciclos reales el árbol quedó limpio.

Lo que quedó probado con agentes reales, con números abajo: la renovación independiente (Codex 3, Claude 8), el contexto real medido, los commits locales en hitos, la comprobación de memoria actuando sola y la ausencia de procesos residuales. Y tres correcciones al reporte P3 anterior:

| El reporte P3 decía | Lo que muestran los datos |
|---|---|
| «El contexto del director llegó a 726 000 tokens» | Era el **acumulado de entrada del hilo** de Codex, no el contexto. El contexto real de Codex llegó a **38 958 de una ventana de 258 400**. |
| «Claude: contexto promedio 252 222» | `result.usage` de Claude **suma todas las solicitudes** de la llamada. El contexto real máximo fue **89 238**. |
| «Dos propuestas se rechazaron por citar criterios abreviados» | **No hubo abreviaciones.** El director dejó criterios sin ninguna tarea (el mensaje los mostraba cortados a 60 caracteres, lo que parecía una cita abreviada). En el segundo ensayo fusionó dos criterios en una cita. |

| Commit | Contenido |
|---|---|
| `041e0b3` | Renovación por agente y medición real de contexto y consumo |
| `d8c8f66` | El script del ensayo del plan usa los dos ajustes |
| `c372117` | Citas de criterios en propuestas |
| `547698a` | Cierre sin cambios de Git sin decidir |
| `71f4d53` | Procesos hijos, limpieza de huérfanos y comprobación de memoria |
| `7df6749` | Script del ensayo ampliado, aislamiento de las pruebas respecto a la RAM, documentación y el reporte inicial |
| `2173793` | Presupuesto de RAM (30 GiB) del árbol de procesos de Automata, supervisado, no un límite duro |
| `9364dd8` | Solo el revisor primario recibe el recordatorio de commit antes de aprobar |
| `3deea58` | Reportes con el ciclo real completo y correcciones del script del ensayo |
| *(commit de cierre)* | Validación final: merge a sí misma, prueba de Chrome de Git, script de ensayo probado, reporte final |

---

## 1. Sesiones y contexto

- `coderRefreshRounds` (Claude, **8**) y `auditorRefreshRounds` (Codex, **3**), ambos en Configuración, validados de 0 a 50 (0 apaga ese agente). Los ajustes guardados con el número único anterior se leen así: el 8 antiguo cede a los nuevos; otro valor elegido vale para ambos. El cambio se aplica también a un trabajo en curso.
- Se renueva solo en puntos seguros (inicio de etapa; nunca en una corrección, un reintento o una continuación), y la sesión nueva recibe plan, memoria y estado en el prompt completo.
- **Medición corregida** (`server/usage.mjs`). Las dos CLI reportan totales que no son el contexto. Claude suma todas las solicitudes de la llamada; Codex da el acumulado de todo su hilo. Ahora el **contexto** es la solicitud más grande: en Claude, de los eventos `assistant`; en Codex, de los `token_count` del archivo de sesión de Codex (se lee, nunca se escribe). El **consumo** por llamada es la diferencia entre acumulados en Codex. Antes, el contador `TOKENS` sumaba el acumulado de Codex en cada ronda y sobrestimaba.

Evidencia real (ciclo de la calculadora de propinas, 10 llamadas de Claude y 12 de Codex, todas con contexto medido):

| | Claude | Codex |
|---|---|---|
| Contexto máximo (una solicitud) | **89 238** | **38 958** (ventana 258 400) |
| Crecimiento por ronda dentro de una sesión | ≈ 7 000 (42 148 → 89 238 en 8 rondas) | ≈ 9 000 (20 897 → 38 958 entre las rondas 3 y 5) |
| Contexto tras renovar | 41 418 | 20 616 / 22 659 |
| Entrada nueva / caché leída / salida | 66 / 1 553 130 / 18 242 | 674 535 de entrada (544 512 en caché) / — / 12 015 |
| Sesiones abiertas | 2 | 4 |
| Renovaciones | 1 (ronda 9, tras 8 rondas) | 3 (rondas 3, 6 y 9, tras 3 rondas cada vez) |

Cada renovación quedó en `sessionLog` con las llamadas y el contexto máximo de la sesión que se cerraba. Claude y Codex renovaron cada uno con su propio ritmo.

**Lo que esto no demuestra:** con contextos de 39 000 y 89 000, ninguna renovación era necesaria por la ventana. Su posible beneficio sería de consumo (menos relectura), y sin un ciclo de control sin renovar no puedo afirmarlo. Los valores 3 y 8 los mantengo porque los pediste.

## 2. Commits locales

**Con Codex real** (5 commits en el proyecto de la calculadora, todos pedidos por el director en hitos con las verificaciones en verde, rondas 5, 7, 8, 9 y 10):

```
22e1fdc test: validar número de personas
fec40e4 test: validar totales negativos e inválidos
615bc33 test: verificar aviso para total vacío
be921c0 test: verificar redondeo de céntimos
43c31c7 test: preparar estructura y pruebas iniciales
4729258 chore: inicio del proyecto
```

La carpeta quedó sin cambios pendientes. La cola de Git del trabajo solo tiene esos 5 commits; no hay remoto, push ni merge.

**Cierre sin cambios sin decidir** (`settleChanges`). Un trabajo no llega a `complete` con la carpeta sucia: (1) si el director aprueba con cambios y sin commit, se le devuelve la revisión una vez; (2) si después de ejecutar su decisión sigue sucia (commit fallido, rechazado por un hook, pendiente de aprobación o no pedido), el trabajo queda `blocked` con un commit de cierre en la barra de aprobaciones: **Guardar**, **Reintentar** (con el error de Git a la vista) o **Dejar sin guardar**, que se anota en eventos y memoria. Al resolverse, el trabajo termina solo. Los archivos sensibles nunca se confirman (se avisa, no bloquean). Con `gitMode: off` no se pregunta. Un commit fallido se recuerda (`gitProblem`) y el director lo ve en su regla de Git. En proyectos creados desde una idea, **push y merge esperan siempre la aprobación**, incluso en modo automático.

Probado con un repositorio real, `GitOps` real y un hook `pre-commit` que de verdad falla (`test/git-gate.test.mjs`, 8 pruebas): hito guardado, recordatorio al director, bloqueo, aprobación, fallo con el error visible, reintento tras arreglar la causa, decisión de dejar sin guardar, archivos sensibles, Git desactivado y la regla de push/merge.

**Con agentes reales (28 oct):** los dos ciclos llegaron a `complete` con la carpeta limpia y cada commit salió de la cola de Git de Automata (sección 6.5). **Sigue sin validarse con agentes reales** el caso de cierre con cambios sin guardar (bloqueo y botones Guardar, Reintentar, Dejar sin guardar) y el recordatorio al director, porque los directores reales ya habían guardado todo. Eso queda cubierto por las pruebas con Git real y director simulado y, desde la validación final, por una prueba de Chrome (`smoke-git`, sección 6.2).

## 3. Propuestas

Reproduje contra el validador las propuestas que Codex entregó de verdad (guardadas en `test/fixtures/real-proposals.json`). De 6 intentos reales de Codex en 3 ideas, **4 se rechazaron y ninguno por abreviación**:

| Caso real | Qué pasó | Ahora |
|---|---|---|
| Inventario, intentos 1 y 2 | Criterios sin ninguna tarea | Sigue rechazado; el mensaje trae el criterio **completo** |
| Gastos, intento 1 | 3 tareas citan dos criterios pegados | **Se acepta al primer intento**: la tarea queda ligada al primero y el segundo recibe una tarea «Comprobar: …» al final |
| Inventario, intento 3 | Válida | Pasa igual |
| Calculadora, intento 1 (ciclo de hoy) | Un criterio sin tarea | Rechazado con el criterio completo |
| Calculadora, intento 2 | Válida | Aceptada; `attempts: 2` |

Se resuelven además, sin pedir otra propuesta: otra mayúscula, acento o puntuación, cita cortada que abre un solo criterio, trozo de un criterio y criterio con texto alrededor. Se rechazan las citas ambiguas (encajan con varios), las inexistentes y los criterios que nadie menciona. El prompt ahora pide copiar el criterio completo y uno solo por tarea.

**Pendiente de tu decisión:** la causa dominante en los datos reales es la **omisión** de criterios (3 de 4 rechazos), no la forma de citarlos. Podría crearse automáticamente una tarea «Comprobar: …» para cada criterio omitido, como ya se hace con los fusionados; lo dejé sin hacer porque debilita la exigencia de que el director piense cómo construir cada criterio.

## 4. Memoria RAM

**Investigación (solo lectura, sin cerrar nada ni cambiar configuración):**

| Momento | RAM libre | Qué ocupaba |
|---|---|---|
| Primera inspección | 7 835 MB de 64 912 | Un entrenamiento de Python ajeno a Automata (`tools.catalog.train_sep`, en `C:\ai-dj-lab-work`, un proceso padre y 4 trabajadores) con **≈ 41 GB**; QEMU 3,9 GB; Chrome 4,1 GB |
| Justo antes del ciclo | 4 470 MB | — |
| Al detener el ciclo | **1 130 MB** | El mismo entrenamiento en **≈ 57,8 GB** |

- Los procesos de Claude (4, 1,6 a 2 GB en total) son sesiones interactivas de Claude Code, no de Automata. No había `codex.exe` ni instancias de Automata en memoria.
- **No hay evidencia de que Automata, Claude o Codex agotaran la memoria**: en la primera inspección los procesos de Node sumaban 324 MB y no había restos de los ensayos anteriores. Windows tampoco registró eventos de agotamiento de recursos (nada desde las 12:00 ni en las últimas 3 horas).
- La causa más probable de los dos cortes (el de ayer y el de hoy) es la presión de memoria creada por el entrenamiento, que creció durante la sesión, y la regla del propio Claude Code, que detiene procesos en segundo plano cuando el sistema queda crítico. **Es una inferencia**: no tengo medición de la memoria del árbol de Automata durante aquel ciclo, porque el muestreo se perdió con el corte. La medición real de un ciclo completo llegó el 28 oct (sección 5.1): el árbol de Automata llegó a 577 MB como máximo.
- Tras el corte no quedó ningún proceso del ensayo (servidor, Claude, Codex o `node`).

**Cambios en Automata:**
- **Registro de hijos** (`server/procs.mjs`, `children.json`): cada agente y cada verificación se anota con su momento de inicio. Al terminar una llamada se cierra lo que dejó corriendo (un servidor de pruebas, por ejemplo), solo si se creó mientras ese agente vivía. Al abrir Automata se cierran los hijos de una sesión cerrada a la fuerza, solo si coinciden id, momento de inicio y programa. Nunca se toca al propio proceso ni a los del sistema. Cada cierre es un evento visible. Al probarlo encontré y corregí un fallo propio: los hijos de un proceso vivo cuyo id había sido reutilizado por otro programa se trataban como restos.
- **Comprobación de recursos** (`server/resources.mjs`, solo lee): memoria libre y margen de memoria virtual de Windows (no son lo mismo), con mínimos de 1 536 y 2 048 MB (`AUTOMATA_MIN_FREE_MB`, `AUTOMATA_MIN_COMMIT_MB`; 0 apaga). Se aplica antes de proponer, aceptar, iniciar, continuar, consultar a un agente y abrir cada agente dentro de un trabajo, donde el trabajo queda en espera («Poca memoria libre en la PC») y reintenta solo.
- **Actuó sola en el ciclo real:** con 978 MB libres el trabajo esperó en vez de abrir otro agente y siguió después, sin intervención.
- Las pruebas automáticas ya no dependen de la RAM del equipo (`test/setup.mjs`): sin eso, con 1,1 GB libres habrían fallado.

**Límite:** la limpieza de hijos se probó con procesos reales, pero no se observó a Claude ni a Codex dejando procesos en segundo plano, así que no sé con qué frecuencia actúa. Es un cambio de comportamiento: lo que un agente deje corriendo al terminar su llamada se cierra; para probar la app, Automata la ofrece.

## 5. Validación real

### 5.1 Ciclos del 28 oct (1:36 am, entrenamiento de AI-DJ ya terminado, 52 GB libres)

Misma frase, misma configuración y segunda instancia (puerto 4796, datos propios). La RAM estaba libre porque terminó el entrenamiento; se lanzó con tu autorización para esa noche y solo Claude hacía pruebas. Dos corridas:

| | Corrida A (presupuesto apagado, 0) | Corrida B (presupuesto 61 440 MB = 60 GiB; no era el valor previsto, ver 6.1) |
|---|---|---|
| Propuesta | 34 s, 7 criterios, 8 tareas | 28 s, 8 criterios, 9 tareas |
| Fin | `complete`, ronda 4, plan 8/8, ≈ 3,5 min | `complete`, ronda 12, plan 9/9, ≈ 10 min |
| Commits locales | 2 (+ el inicial), árbol limpio | 7 (+ el inicial), árbol limpio |
| Pruebas del proyecto | 21 de 21 | 3 de 3 |
| Intervenciones de la persona | 2 (idea y «Crear y empezar») | 2 |
| Renovaciones de sesión | 1 (Codex) | 5 (Codex 4 en rondas 3, 6, 9, 12; Claude 1 en la ronda 9) |
| Contexto máx. real | Claude 66 633 · Codex 26 573 | Claude **92 017** · Codex **36 649** (ventana 258 400) |
| Recuperación | ninguna | 1 respuesta del revisor inválida («plan.update: la tarea T0 no existe»), reintentada y resuelta sin intervención |
| Push / merge ejecutados | ninguno | ninguno; el director **pidió** un merge a `main` y quedó `pending` esperando tu aprobación (correcto) |
| Procesos residuales | 2 «restos» (`powershell.exe` y `conhost.exe`), ya inexistentes al revisar; casi seguro el PowerShell del muestreo del propio script (no lo pude demostrar) y corregido | ninguno |

**RAM medida en la corrida B** (primera medición real de un ciclo completo; 106 muestras del script cada 6 s y 66 del propio Automata cada 20 s):

| | |
|---|---|
| Máximo del árbol de Automata (Claude + Codex + node + git, memoria física) | **577 MB** (script: 469 MB) |
| Máximo de memoria privada | 868 MB |
| Máximo de Claude / Codex | 308 MB / 190 MB |
| Máximo de procesos en el árbol | 13 |
| RAM libre del sistema, mínimo | 51 501 MB (de 64 912) |
| Margen de memoria virtual libre, mínimo | 46 025 MB |
| Estado del presupuesto | `ok` en todas las muestras, 0 excesos |
| Chrome del script (no es de Automata) | hasta 1 150 MB |

Conclusión sobre memoria: el consumo propio de Automata con agentes reales es **menos de 1 GB**, muy por debajo de los 30 GiB; mi estimación previa de 1 a 3 GB era alta. El presupuesto sirve como red de seguridad, no como restricción en la práctica.

**Qué faltó o salió distinto:**
- `ok: false` en las dos corridas lo puso el **script**, no Automata: contaba su propio PowerShell como resto; se cortaba el muestreo al abrir Chrome (`browser.process()` no existe en Playwright; la corrida A quedó con 1 muestra); trataba como fallo un merge solo *pedido* y pendiente de aprobación; y no sabía comprobar una página estática sin dirección. Los cuatro puntos están corregidos y probados (sección 6.4).
- Con el presupuesto en 0, Automata **no mide** por ejecución (`run.memory` queda vacío): es el comportamiento diseñado, pero por eso la corrida A no sirve para RAM.
- **La aplicación entregada**: en el momento de estas corridas solo se había comprobado por sus archivos y sus pruebas. Después se abrió en Chrome y se usó de verdad (sección 6.3).
- El director pidió un merge a `main` aunque el proyecto solo tiene `main`: no se ejecutó (requiere aprobación). Se corrigió (sección 6.5): ya no se pide ni se encola.
- Una sola idea, pequeña y de una página: no demuestra el comportamiento con proyectos grandes ni con Git ensuciado a propósito en vivo.

Carpetas resultantes: `C:\Users\cellh\Automata Projects\repartidor-de-propina` (A) y `calculadora-de-propinas-2` (B); artefactos en `artifacts\real-idea-2026-10-28T08-36-28-071Z` y `...T08-41-12-371Z`.

### 5.2 Primer ciclo (27 oct, interrumpido)

Ciclo con la frase «Quiero una calculadora de propinas: escribo el total de la cuenta y cuántas personas somos, y me dice cuánto paga cada una», en una segunda instancia (puerto 4796, datos propios), Claude `sonnet`, Codex `gpt-6-luna`, acceso limitado, solo planes, `ask-push`.

| Resultado | |
|---|---|
| Propuesta | 31 s, 2 intentos, 7 criterios, 8 tareas, página web local |
| Intervenciones de la persona | Escribir la idea y «Crear y empezar» (2) |
| Avance | Ronda 11, 6 de 8 tareas hechas, en unos 6,5 minutos |
| Commits locales | 5, carpeta limpia |
| Fin | **Detenido por el arnés a las 15:55 por memoria crítica del sistema** |

Ese ciclo no llegó al `complete`; lo cubren las corridas de 5.1. No forcé rondas para cumplir métricas.

**Para repetirlo** (el script muestrea RAM, procesos de Automata, Chrome y el entrenamiento cada 6 s, comprueba commits, árbol limpio, ausencia de remoto, push y merge ejecutados, comprueba la aplicación entregada y busca procesos residuales):

```powershell
node scripts/real-idea.mjs --port 4796 --rounds 16 --idea "Quiero una calculadora de propinas: escribo el total de la cuenta y cuántas personas somos, y me dice cuánto paga cada una"
```

El proyecto parcial quedó en `C:\Users\cellh\Automata Projects\calculadora-de-propinas`; un nuevo ciclo creará otra carpeta.

## 6. Validación final (28 oct)

Sin funciones nuevas: solo comprobaciones, la corrección del merge de `main` hacia `main` y las pruebas que faltaban. Entrenamiento de AI-DJ terminado (sin procesos Python, GPU casi en reposo) y 50 414 MB de RAM libre al cerrar esta sección; no hubo ningún entrenamiento simultáneo.

### 6.1 Memoria: valor efectivo y qué significa

| Comprobación | Resultado |
|---|---|
| `AUTOMATA_RAM_BUDGET_MB=30720` | `defaultBudget()` = **30 720 MB = 30 GiB**; `coordinator.settings.ramBudgetMB` = 30 720; `/api/state` = 30 720. Sin la variable, el valor por defecto es el mismo (30 720) |
| Lectura real con ese presupuesto | árbol de Automata 239 MB (5 procesos) · estado `ok` |
| ¿Fue 60 GiB? | **Sí, en la corrida B del 28 oct**: la lancé con 61 440 MB por decisión mía, para tener medición, y no era el valor previsto. Quedó anotado en 5.1. El script de ensayo ahora usa 30 720 salvo que se le indique otro valor y guarda el valor realmente usado en `report.final.memory.budgetMB` |
| Variable de entorno del sistema | **No la fijé de forma permanente**: sería un cambio de configuración global de tu equipo. No hace falta para el valor efectivo (el defecto ya es 30 720). Si la quieres explícita, es un comando tuyo. Un valor guardado en Ajustes manda sobre la variable |

**Presupuesto supervisado, no límite duro.** Automata mide cada 20 s el árbol que cuelga de su proceso, y antes de abrir un agente o una verificación comprueba que el árbol más 1 024 MB de reserva quepa en el presupuesto y que al sistema le queden 1 536 MB libres y 2 048 MB de margen. Si no cabe, espera; si se excede, avisa y **no inicia procesos nuevos**, pero **no cierra ni limita** el que ya corre. Un proceso que crezca de golpe más allá del presupuesto no se detiene. El único límite duro posible sería un Job Object de Windows, que **no se probó** (el permiso del experimento fue denegado) y no está implementado.

### 6.2 Interfaz en Chrome

Las 12 pruebas `smoke-*` que usan Chrome se ejecutaron con agentes simulados (sin IA) y terminaron con código 0: `smoke` (13 comprobaciones), `smoke-access` (8), `smoke-auth` (14), `smoke-chat` (7), **`smoke-git` (20, nueva)**, `smoke-github` (10), `smoke-ideas` (27/27), `smoke-memory`, `smoke-plan` (18/18), `smoke-settings` (ampliada), `smoke-waiting` (12/12) y `smoke-window`.

| Lo que pediste ver | Qué lo cubre y qué comprobó |
|---|---|
| Botones de Git | `smoke-git`, con repositorios reales: con cambios sin guardar el trabajo queda bloqueado y aparece **Guardar** y **Dejar sin guardar** (Guardar crea el commit y el trabajo termina con la carpeta limpia); con un `pre-commit` que falla se ve «No se pudo guardar · las pruebas locales no pasan» con **Reintentar** (funciona al arreglar la causa); **Dejar sin guardar** termina sin commit, deja los cambios y lo anota; un merge desde una rama de trabajo pide **Aprobar / Rechazar** y Rechazar no toca `main`; `main` hacia `main` no genera nada |
| Configuración por agente | `smoke`: modelo y razonamiento de Claude y de Codex por separado. `smoke-settings`: renovación de sesión de cada agente (Claude 8, Codex 3, editadas a 5 y 2 y guardadas) y el presupuesto de RAM (valor inicial, un valor inválido se rechaza sin guardar, 20 480 se guarda) |
| Panel Plan | `smoke-plan` (18/18): agregar, corregir, reordenar, descartar y restaurar tareas, ciclo con el director, contador PLAN, inglés y teléfono |
| Creación de ideas | `smoke-ideas` (27/27): mensaje casual que no inicia nada, propuesta en palabras sencillas, ajuste, una sola aprobación y avance |
| Móvil | 390 px sin desbordamiento horizontal en `smoke`, `smoke-ideas`, `smoke-plan`, `smoke-memory`, `smoke-settings`, `smoke-waiting` y `smoke-git` (que además comprueba que los botones de Git quedan dentro de la pantalla) |

Un fallo antiguo que apareció: `smoke-settings` fallaba en «Settings opens connection controls». **No era una regresión de P3**: falla igual en `868d2dc` (lo comprobé en un árbol temporal, ya eliminado). El diálogo se abre después de que responde la petición de emparejamiento y la prueba lo leía sin esperar; ahora espera. Nada de la aplicación cambió.

**No se ejecutaron:** `smoke-phone` (necesita un teléfono Android por adb; el puerto 5037 lo usa un `adb.exe` que no toqué), `smoke-desktop` y `smoke-recovery` (abren Electron y el `.exe` empaquetado), `smoke-console` (sondeo de ventanas de Windows con llamadas nativas). Las pruebas usan Chrome sin ventana (headless) y datos aislados: no vi la interfaz en una pantalla real del teléfono.

### 6.3 Aplicación entregada, abierta en Chrome

Abrí en Chrome real, con `file://`, las **dos** calculadoras (`repartidor-de-propina` y `calculadora-de-propinas-2`) y las usé como una persona: 24 comprobaciones por aplicación, con capturas en `artifacts/final-validation` (el guion `app-check.mjs` y `app-check.json` están ahí; esa carpeta no se versiona).

| | A · repartidor-de-propina | B · calculadora-de-propinas-2 |
|---|---|---|
| Resultado | **24 de 24** | **21 de 24** |
| Operaciones normales (100/2/10 %, 80/4/15 %, 45,60/1/20 %, 0 %) | correctas, con coma decimal en pantalla | correctas |
| División entre personas (100, 3 personas, 10 %) | 36,67 | 36.67 |
| Redondeo (33.33/3/15 % → 5.00 · 38.33 · 12.78; 1.005 al 100 % → 1.01; coma «85,50») | correcto | correcto |
| Importe vacío, cero, negativo o texto | aviso y sin resultado | vacío, negativo y texto: aviso y sin resultado. **Cero: muestra 0.00 / 0.00 / 0.00 sin aviso** |
| Personas vacías, cero, negativas, decimales o texto | aviso y sin resultado | aviso y sin resultado |
| Propina negativa o texto | aviso | **oculta el resultado pero sin ningún mensaje** |
| Tras un error | el resultado anterior desaparece; se recupera con datos válidos | igual |
| Teléfono (390 px) | sin desbordamiento | sin desbordamiento |
| Errores de consola | ninguno | ninguno |

Los 3 fallos de B son contra lo que una persona esperaría; **ninguno incumple los 8 criterios de su propia lista** (el 5 pide aviso solo para importe vacío, negativo o no numérico, y el código lo dice: «el porcentaje aún no tiene mensaje propio»). Aun así son huecos de calidad que la revisión del director no vio. A cumple también el cero y la propina inválida porque su lista sí lo pedía. Además: el cálculo por persona redondea a céntimos el total dividido (por ejemplo 38,33 entre 3 da 12,78 y 3 × 12,78 = 38,34), y B no tiene estilos; eso no estaba pedido.

### 6.4 Las correcciones del script de ensayo, probadas

Las cuatro correcciones quedaron en `scripts/real-idea-checks.mjs` y se prueban en `test/real-idea-checks.test.mjs` (5 pruebas):

1. **Restos:** el PowerShell/conhost de muestreo del propio script no cuenta; los huérfanos de un servidor ya muerto **sí** (probado con una tabla simulada y con procesos `node` reales que la prueba lanza y cierra ella misma); un servidor que sobrevive también se informa, con todo su árbol (esto lo descubrí al escribir la prueba: mi primera regla lo habría escondido); lo que ya existía antes, lo anterior al inicio y Chrome no cuentan.
2. **Muestreo con Chrome abierto:** Chrome se reconoce por los `chrome.exe` nuevos, sin `browser.process()` (la prueba también falla si el script lo vuelve a usar). Con la corrección, la corrida B tuvo 106 muestras.
3. **Merge/push pedido frente a ejecutado:** pendiente → no es un fallo (se cuenta aparte); hecho o fallido → sí; un `merge` o `push` en el reflog delata uno real aunque no esté en la cola.
4. **Página estática:** se comprueba el archivo que abre el comando entregado (existe, título, campos); un archivo inexistente o un comando sin página no se da por bueno.

**Límite:** después del refactor el script solo se comprobó por sintaxis y por estas pruebas; **no se volvió a ejecutar de punta a punta con agentes**, porque no hacía falta otro ciclo de desarrollo.

### 6.5 Git

- **`main` hacia `main` nunca se propone:** el prompt del director ahora le dice la rama actual y que no pida fusionar una rama en sí misma; el coordinador además descarta la petición sin cola ni aprobación (`Se omitió fusionar main en sí misma`). Una rama de trabajo sí puede pedir su merge, que queda pendiente de aprobación. 2 pruebas nuevas, más `smoke-git`. La prueba antigua que simulaba Git ahora cambia de rama como el repositorio real.
- **Los commits los hizo el flujo de Automata:** cruzando la cola de Git de cada trabajo con `git log`, los 7 commits de B y los 2 de A coinciden **uno a uno** con una entrada `commit` «hecha» de la cola (mismos hashes, rondas 2 a 12); no hay ningún commit fuera de la cola, salvo el inicial, que crea Automata al abrir el proyecto (`chore: inicio del proyecto`). Una entrada de B fue «Sin cambios para confirmar» (no creó nada). Se firmaron con la identidad de Git de este equipo.
- **Sin push ni merge:** ningún proyecto tiene remoto, no hay `merge` ni `push` en los reflogs y el único merge pedido (el de `main` hacia `main`) no se ejecutó. En este repositorio tampoco hice push.

### 6.6 Pruebas

`npm test`: **195 de 195** (188 anteriores + 5 de `real-idea-checks` + 2 de `git-gate`). Ligeras y deterministas.

### 6.7 Fallos y límites que siguen

- B no avisa con importe 0 ni con propina negativa o de texto (6.3).
- No se ejecutaron `smoke-phone`, `smoke-desktop`, `smoke-recovery` ni `smoke-console` (6.2).
- El script de ensayo no se reejecutó de punta a punta tras corregirlo (6.4).
- El cierre con Git sucio y el recordatorio al director no se vieron con agentes reales, solo con director simulado (sección 2).
- Una sola idea pequeña; no se probaron proyectos grandes ni la espera larga por memoria (las esperas por memoria consumen los reintentos de P1 y tras ≈ 17 min pasan a `error`).
- No hay límite duro de memoria (6.1).
- `package-lock.json` sigue sin versionarse, a propósito.

## Pruebas (resumen)

`npm test`: **195 de 195** (180 al cerrar la estabilización inicial, 188 con el presupuesto de RAM y 195 con la validación final). Las pruebas de interfaz en Chrome (`smoke-*`) **sí se ejecutaron** en la validación final: 12 de 12 con código 0 (sección 6.2), salvo las que necesitan teléfono o Electron. Ya no queda ningún cambio de `public/` sin verse en un navegador.

## Decisiones que necesito de ti

1. **Aprobar el cierre de P3** (rama `feature/p3-idea-to-project`, sin push ni merge) o indicar qué falta. No empiezo P4 ni hago push hasta tu autorización.
2. Las dos calculadoras entregadas tienen huecos menores (6.3): ¿pedimos a Automata que los corrija como un trabajo nuevo, o se dejan como prueba de que el director puede pasar por alto detalles que su lista no exigía?
3. ¿Creo automáticamente la tarea «Comprobar: …» para criterios omitidos por el director? (Causa dominante de rechazos de propuestas.)
4. ¿Mantienes Codex en 3 rondas? Con contextos de 37 000 a 39 000 en una ventana de 258 400, la renovación no es necesaria por tamaño; en el último ciclo hubo 5 renovaciones.
5. ¿Aceptas que se cierre lo que un agente deja corriendo al terminar su llamada?
6. ¿Hago que las esperas por falta de memoria no consuman los reintentos de P1 y se repitan sin límite? Hoy a los ≈ 17 minutos pasan a `error`.
7. ¿Fijo `AUTOMATA_RAM_BUDGET_MB=30720` como variable de usuario de Windows? Hoy no hace falta: el valor por defecto ya es 30 720.
8. ¿Subes el mínimo de RAM libre del sistema de 1 536 MB a unos 4 096 MB? Con el entrenamiento ya terminado no estorba, pero mientras entrene sí.
9. Job Objects: sigo sin probarlos; solo con tu permiso de PowerShell para ese experimento.
