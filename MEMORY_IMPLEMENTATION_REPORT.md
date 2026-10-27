# Memoria persistente de Automata: reporte de implementación

Fecha: 26 oct 2026 · Rama: `feature/memoria-proyecto`, a partir de `feature/director-observa-planes` · Sin push.

## Resultado

La memoria nativa está implementada, probada con agentes simulados y validada en dos trabajos reales con Claude y Codex:
- La segunda ejecución real del mismo proyecto empezó con sesiones nuevas.
- Recuperó las decisiones de la primera.
- Recibió la solución de un error que volvió a aparecer.
- Terminó en **2 rondas en vez de 3**, con **la mitad de tokens del director**.

No se instalaron hooks, servicios, puertos ni dependencias, y no se tocó la configuración global de Claude ni de Codex.

| Commit | Contenido |
|---|---|
| `3ec8527` | Almacenamiento (`server/memory.mjs`, `server/redact.mjs`) e integración con el coordinador, los prompts, el esquema del director y la API |
| `28341ee` | Panel Memoria (buscar, agregar, corregir, retirar, restaurar), español e inglés, vista de teléfono |
| `61c00e9` | Secretos fuera de los registros originales (`*.jsonl`), eventos, reportes y salida de verificaciones |
| *(este commit)* | Un archivo de memoria por fase, documentación, avisos de licencia y este reporte |

---

## Qué se construyó

| Requisito | Dónde | Cómo |
|---|---|---|
| 1. SQLite + FTS5 | `server/memory.mjs` | `node:sqlite` del Node de Electron (comprobado: Node 24.15, SQLite 3.51.3, FTS5 y BM25). Cero dependencias nuevas. |
| 2. Una base por proyecto | `MemoryStore.file()` | `<datos>/memory/<id del proyecto>.db`, fuera de la carpeta del proyecto. El archivo guarda su dueño y se rechaza si se copia a otro proyecto. Los ids se validan (no se aceptan rutas). |
| 3. Reutilizar la captura | `coordinator.mjs` | Los eventos que ya decodificaba `decodeEvents` y la bitácora `observe`, los resultados de `runChecks`, `review.json`, los commits de `GitOps` y las respuestas del chat. Sin hooks. |
| 4. Errores ligados a soluciones verificadas | `recordChecks`, `recordCommands` | La firma del error es el comando más la primera línea de error, normalizada. La solución se guarda con la ronda, los archivos (de la bitácora) y el resumen, y se marca verificada por la verificación o el comando que volvió a funcionar. Si reaparece, se reabre y cuenta las veces. |
| 5. Decisiones, entorno, avances y pendientes | `facts`, `REVIEW_SCHEMA.memory`, «PARA RECORDAR:» | Campo `memory.add` y `memory.retire` del director; sección «PARA RECORDAR:» en los reportes de Claude y en el chat; los criterios abiertos son pendientes automáticos; los commits y los resúmenes son avances. |
| 6. Solo lo relevante | `brief()` | Soluciones para lo que falla ahora (la misma firma o una parecida por FTS); luego entorno, decisiones, pendientes, trampas, errores resueltos, avances y notas. Dentro de cada sección va primero lo que coincide con la tarea. |
| 7. Unos 1 500 tokens | `allocateBudget` | Presupuesto estricto por secciones (corregido respecto a local-mem para no pasarse nunca). |
| 8. Historial completo aparte | `runs/<id>/round-NN/` | La memoria solo guarda resúmenes con el trabajo y la ronda de origen. El bloque que recibió cada agente queda en `memory-plan.txt`, `memory-code.txt` o `memory-review.txt`. Las correcciones quedan en `fact_revisions`. |
| 9. Corregir, retirar, consultar | Panel Memoria y `POST /api/memory` | `list`, `brief`, `add`, `update`, `retire`, `restore`, `history` y `errorStatus`. |
| 10. Sobrevive a reinicios | Archivo por operación | Transacciones con `synchronous = FULL`; sin conexiones abiertas entre operaciones. |

**Seguridad:**
- **Sin hooks globales, configuración global, servicios, puertos ni procesos residentes.** La memoria se lee y se escribe solo dentro de las operaciones del coordinador.
- **Sin secretos en la memoria.** Antes de guardar se aplica `redactSecrets`: formas de token, asignaciones (`password=`, `"api_key": …`), bloques PEM, contraseñas en URL y cadenas aleatorias de alta entropía. Los archivos sensibles no se guardan en las soluciones.
- **Registros originales.** Antes de este cambio, los `*.jsonl` guardaban crudo lo que devolvían las herramientas: si Claude leía un `.env`, sus valores quedaban en disco. Ahora cada línea JSON se limpia campo por campo y se vuelve a escribir como JSON válido. Lo mismo se aplica a los eventos, los reportes y la salida de las verificaciones.
- **Sin lecturas entre proyectos.** Un archivo por proyecto, su dueño comprobado y la API exige un proyecto existente.
- **Licencia:** el aviso MIT de local-mem está en el encabezado de `server/redact.mjs`, en `THIRD_PARTY_NOTICES.md` y en el paquete de Windows (`AVISOS_DE_TERCEROS.md`).
- **Tolerancia a fallos:** si la memoria falla, se muestra un aviso una vez y el trabajo sigue (probado).

---

## Pruebas

### Automáticas: 115 de 115 (antes 99)

`test/memory.test.mjs` (9 pruebas):
- aislamiento entre proyectos y rechazo de ids con rutas o de un archivo copiado de otro proyecto;
- persistencia tras abrir otra instancia, y que leer un proyecto sin memoria no crea archivos;
- error de verificación → solución con archivos y ronda → reaparición con la solución en el bloque;
- comando de compilación que falla y luego funciona, con lo que cambió en medio; los comandos de exploración no se registran;
- corregir, retirar y restaurar con historial, y deduplicación;
- `memory.add` y `memory.retire` del director, y pendientes automáticos que se retiran al completar;
- presupuesto: 122 hechos largos caben en ≤ 1 500 tokens y lo relevante va primero;
- 8 tipos de secreto y bloques PEM: ninguno queda en el archivo `.db` ni en el bloque; los hashes y rutas sí se conservan; la variante para JSON no rompe las líneas;
- firmas, «PARA RECORDAR» y saneamiento FTS.

`test/memory-flow.test.mjs` (7 pruebas):
- ciclo completo con agentes simulados: un trabajo nuevo recupera decisión, entorno y error resuelto; el mismo error reaparece y la instrucción de corrección trae la solución; queda el aviso «Este error ya había pasado»;
- aislamiento en el ciclo, el chat y la API;
- los recuerdos retirados no llegan a los prompts y cada bloque respeta los 1 500 tokens;
- el esquema del director y las revisiones viejas sin `memory`;
- la memoria rota no detiene el trabajo;
- una CLI simulada que «lee» un `.env`: el `.jsonl`, los eventos y el reporte quedan sin secretos y con JSON válido;
- la API por HTTP: token, agregar, corregir, retirar, restaurar, buscar e historial.

### Interfaz en Chrome

- `scripts/smoke-memory.mjs`: 13 de 13. Lista, el secreto oculto, el error con su solución, contadores, agregar, corregir, retirar (deja de llegar a los agentes), restaurar, buscar, teléfono sin desbordamiento, sin errores de la página y sin peticiones externas.
- `npm run smoke` (la prueba general existente): 13 de 13.

### Real, con Claude y Codex

**Montaje:**
- Una **segunda instancia** del servidor con el código nuevo, en el puerto 4790 y con su propia carpeta de datos, para no tocar tu Automata abierto.
- Proyecto aislado en `C:\Users\cellh\Automata Projects\paso0-memoria`, con la misma prueba de aceptación del Paso 0 v2.
- Acceso limitado. Claude `claude-sonnet-5-5` (razonamiento medio) y Codex `gpt-6-luna`, los dos con sus planes (`apiKeySource: none`).

**Ejecución 1** (`8f80c739`, memoria vacía):
- **complete** en 3 rondas, unos 2 min 10 s.
- La memoria se llenó sola:
  - 8 hechos de Claude («PARA RECORDAR»), entre ellos 4 decisiones como «el subtotal suma fracciones exactas y redondea una sola vez»;
  - 3 avances del director y el commit `4ef435e`;
  - los 5 criterios pendientes, retirados al completar (el director retiró uno por su número con `memory.retire`);
  - el error **E1** (faltaba la CLI), **resuelto** con `src/cuenta.mjs`, `src/cli.mjs` y `README.md`, verificado por `node --test`.

**Reinicio:** detuve la instancia y la abrí con el código final sobre la misma carpeta de datos. La memoria seguía completa (11 activos, 5 retirados, 1 error resuelto).

**Ejecución 2** (`a02ec890`): quité la implementación con un commit e inicié un trabajo nuevo, con sesiones nuevas.

| Comprobación | Evidencia |
|---|---|
| Una sesión nueva recupera decisiones | `round-00/plan-prompt.txt` incluye «MEMORIA DEL PROYECTO» con las 4 decisiones, E1 resuelto, avances y notas: **631 tokens** |
| La solución de un error reaparece con él | El mismo fallo (firma idéntica) volvió en la ronda 1. Automata avisó «Este error ya había pasado (E1)», y `round-02/code-prompt.txt` empieza con «SOLUCIONES CONOCIDAS PARA LO QUE FALLA AHORA: [E1] (el mismo error) … Se resolvió en la ronda 2 cambiando src/cuenta.mjs, src/cli.mjs, README.md» |
| La memoria cambia el resultado | Claude escribió desde el inicio «suma exacta con denominador común y un único redondeo» (`src/cuenta.mjs:51`). El director **aprobó en su primera revisión**: 2 rondas contra 3. |
| Costo | Tokens de entrada del director: 377 000 en la ejecución 1 y **189 000** en la 2 |
| Presupuesto | Bloques reales de 2 500 a 4 100 caracteres (unos 630 a 1 030 tokens) |
| Registros originales | 57 de 57 líneas JSONL válidas con la redacción nueva |
| Estado final | 8 de 8 pruebas de aceptación; commit `daa7ef5` del director |

**Lo que no se probó en real:**
- La redacción de un secreto verdadero en un registro real: no había secretos en el proyecto. Está probada con una CLI simulada.
- El registro de comandos de compilación fallidos: en acceso limitado Claude no corre comandos. Está probado con agentes simulados.
- El panel Memoria contra estos datos reales: el panel está probado en Chrome con datos de demostración.

---

## Hallazgos y limitaciones

1. **Un archivo de memoria sobrescrito (corregido).** En una ronda con corrección, Claude y el director escribían el mismo `memory.txt`, y el del director tapaba el que recibió Claude. Lo vi al revisar la prueba real. Ahora hay un archivo por fase; el prompt real de Claude ya traía la solución.
2. **Recuerdos que quedan obsoletos.** En la ejecución 2, la nota «las pruebas propias están en `test/subtotal.test.mjs`» ya no era cierta porque yo había borrado el archivo. Claude lo notó y lo anotó como trampa. El director no retiró la nota: usó `memory.retire` una vez en 5 revisiones y `memory.add` nunca. La advertencia del prompt («es un resumen, no evidencia») funcionó, pero hoy la limpieza depende del panel o de que el director la haga. Mejora posible: marcar como dudosos los hechos que mencionan archivos que ya no existen.
3. **Claude anota bastante; el director, poco.** Casi todo el conocimiento útil vino de las secciones «PARA RECORDAR» de Claude. Funciona, pero conviene vigilar el ruido: hay un tope de 6 por reporte y de 60 notas activas.
4. **Las firmas son textuales.** La misma causa con otro mensaje de error es otro error. FTS encuentra los parecidos, pero no hay búsqueda por significado (sería decisión aparte; no hace falta para lo visto).
5. **La memoria no reemplaza la sesión.** Dentro de un mismo trabajo, las CLI siguen retomando su sesión (`--resume`). La memoria cubre lo que una sesión nueva no sabe.
6. **Tu Automata abierto (puerto 4780) sigue con el código anterior.** La memoria empieza a funcionar cuando lo cierres y lo vuelvas a abrir. Los proyectos existentes empiezan con la memoria vacía.
7. **Los registros viejos no se limpiaron.** Los `*.jsonl` escritos antes de `61c00e9` no se reescribieron; solo los nuevos salen limpios.

---

## Qué falta para la recuperación automática ante errores y límites de uso (P1)

La memoria resuelve la parte de **contexto**: si una sesión se pierde después de una espera larga, el trabajo nuevo ya no empieza de cero. Falta la parte de **control**:

1. **Clasificar los errores de las CLI** en `CliAgents.attempt` (`server/agents.mjs`):
   - **límite de uso**, con la hora de reinicio si la CLI la da;
   - **pasajero** (red, código distinto de 0 sin trabajo hecho);
   - **respuesta mal formada** (JSON inválido);
   - **fatal**.

   Primero hay que **capturar ejemplos reales** del mensaje de límite de cada CLI: no ha aparecido ninguno en estas pruebas.
2. **Estado `waiting` con `resumeAt`** en el coordinador:
   - un temporizador que reanuda solo desde la misma etapa;
   - reintentos acotados con espera creciente cuando no hay hora de reinicio;
   - Pausar y Detener siguen mandando.
3. **Volver a preguntar al director** cuando `validateReview` rechaza su respuesta (JSON inválido o `complete` sin evidencia), pasándole el error, hasta 3 veces.
4. **Reanudación al abrir Automata** (`autoResume`): los trabajos `interrupted` siguen sin pulsar «Continuar», y los mensajes del chat interrumpidos se reencolan una vez. Opcional: abrir Automata al iniciar Windows (`app.setLoginItemSettings`, sin dependencias).
5. **Registrar la interrupción en la memoria** como avance («interrumpido en la ronda N por límite; reanudar en la etapa X»), para que la sesión que retome tenga el contexto aunque `--resume` falle. La pieza ya existe (`addFact`); falta llamarla desde el nuevo manejo de errores.
6. **Interfaz:**
   - «Esperando a que se reinicie tu límite · sigue a las 3:40»;
   - los controles por agente que pediste: cancelar un mensaje sin cortar el ciclo, e interrumpir para preguntar y luego seguir. Para esto, Automata debe guardar el id de sesión en cuanto llega el evento `init`, no al terminar.
7. **Pruebas:** CLI simuladas que respondan con límite de uso, JSON inválido, máximo de turnos y cierre a mitad de ronda; y una prueba real larga que atraviese una espera por límite.

Archivos principales: `server/agents.mjs` (clasificación), `server/coordinator.mjs` (`launch`, `loop`, constructor), `server/config.mjs` (`autoResume`, `maxRetries`), `desktop/main.cjs` (inicio con Windows), `public/app.js` (estado de espera y controles por agente).
