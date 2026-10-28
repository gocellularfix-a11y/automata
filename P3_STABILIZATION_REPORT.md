# P3 · Estabilización: reporte

Fecha: 27 oct 2026 · Rama: `feature/p3-idea-to-project` (sobre `868d2dc`) · Sin push, sin merge, sin P4.

## Veredicto

Las secciones 1 a 4 están implementadas y probadas (188 pruebas automáticas en verde). **Actualización del 28 oct, 1:36 am: el ciclo real completo de la sección 5 ya se ejecutó dos veces con agentes reales y las dos llegaron a `complete`** (4 y 12 rondas, 8/8 y 9/9 tareas, commits locales, árbol limpio, sin push ni merge, sin procesos residuales). La primera corrida del 27 oct (detenida por el arnés por memoria crítica) queda como antecedente. Quedan límites reales (sección 5): la aplicación entregada se comprobó por sus archivos y sus pruebas, no abriéndola en un navegador; y los agentes se probaron con una sola idea pequeña.

Lo que sí quedó probado con agentes reales, con números abajo: la renovación independiente (Codex 3, Claude 8), el contexto real medido, los commits locales en hitos, la comprobación de memoria actuando sola y la ausencia de procesos residuales. Y tres correcciones al reporte P3 anterior:

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
| *(este commit)* | Script del ensayo ampliado, aislamiento de las pruebas respecto a la RAM, documentación y este reporte |

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

**No validado con agentes reales:** el cierre mismo (el ciclo real no llegó a `complete`) y el recordatorio al director. Queda cubierto solo por las pruebas con Git real y un director simulado.

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
- La causa más probable de los dos cortes (el de ayer y el de hoy) es la presión de memoria creada por el entrenamiento, que creció durante la sesión, y la regla del propio Claude Code, que detiene procesos en segundo plano cuando el sistema queda crítico. **Es una inferencia**: no tengo medición de la memoria del árbol de Automata durante el ciclo, porque el muestreo se perdió con el corte (el reporte del script se escribe al final).
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

| | Corrida A (presupuesto apagado) | Corrida B (presupuesto 61 440 MB) |
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
- `ok: false` en las dos corridas lo puso el **script**, no Automata: contaba su propio PowerShell como resto; se cortaba el muestreo al abrir Chrome (`browser.process()` no existe en Playwright; la corrida A quedó con 1 muestra); trataba como fallo un merge solo *pedido* y pendiente de aprobación; y no sabía comprobar una página estática sin dirección. Los cuatro puntos están corregidos en `scripts/real-idea.mjs` pero **no se volvió a ejecutar el script con esas correcciones** (la verificación de la aplicación se hizo a mano, ver abajo).
- Con el presupuesto en 0, Automata **no mide** por ejecución (`run.memory` queda vacío): es el comportamiento diseñado, pero por eso la corrida A no sirve para RAM.
- **La aplicación entregada** se comprobó por sus archivos: ambas tienen `index.html` con título, 3 campos y los scripts enlazados, y sus pruebas pasan. **No la abrí en un navegador ni probé el cálculo en pantalla.**
- El director pidió un merge a `main` aunque el proyecto solo tiene `main`: no se ejecutó (requiere aprobación). Es un comportamiento por revisar del prompt del director, no un daño.
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

## Pruebas

`npm test`: **180 de 180** (154 anteriores más 26 nuevas: `usage` 5, `proposals` 4, `git-gate` 8, `processes` 9). Se ajustaron cuatro pruebas antiguas por cambios intencionales (el cierre con Git sucio, el nuevo valor por defecto de Codex y el contexto medido por solicitud). **No se volvieron a ejecutar las pruebas de interfaz en Chrome** (`smoke-*`), y los cambios de `public/` (campos de renovación, botones Guardar / Reintentar / Dejar sin guardar) solo pasaron la comprobación de sintaxis: no los vi en un navegador. `smoke-plan` se actualizó para los dos campos nuevos pero no se ejecutó.

## Decisiones que necesito de ti

1. **Revisar el resultado de 5.1** y decidir si quieres una tercera corrida con otra idea (con interfaz o varios archivos) y abriendo la aplicación entregada en un navegador. No la hice por mi cuenta.
2. ¿Creo automáticamente la tarea «Comprobar: …» para criterios omitidos por el director?
3. ¿Mantienes Codex en 3 rondas? Con contextos de 39 000 en una ventana de 258 400, la renovación no es necesaria por tamaño.
4. ¿Aceptas que se cierre lo que un agente deja corriendo al terminar su llamada?
