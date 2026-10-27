# Paso 0: primera ejecución real del ciclo autónomo

## Veredicto: Paso 0 aprobado (segundo trabajo)

El segundo trabajo (`a18abe71`, proyecto «Paso 0 · cuenta v2») llegó a **`complete`**:
- Con agentes reales y sin mensajes manuales entre rondas.
- Con las 2 verificaciones aprobadas en la ronda final.
- Con evidencia para los 5 criterios.
- Con un commit automático decidido por el director.

El primer trabajo (más abajo) se bloqueó por un criterio mal definido. El segundo usó el mismo proyecto con los límites corregidos.

### Segundo trabajo: datos reales

Fecha: 26 oct 2026, 19:28:46–19:30:57 (hora local), **2 min 11 s** en total.

| Ronda | Quién | Qué pasó | Datos |
|---|---|---|---|
| Plan | Codex | Leyó la prueba primero; pidió solo `src/cuenta.mjs` | 52 000 tokens de entrada |
| 1 · código | Claude | `src/cuenta.mjs` | 30 s, 4 turnos, **0 permisos negados** |
| Verificaciones | Automata | Falla la aceptación (faltan la CLI y el README); integridad aprobada | — |
| 2 · corrección directa | Claude | `src/cli.mjs` y `README.md` | 25 s, 4 turnos |
| Verificaciones | Automata | Las 2 aprobadas | — |
| Revisión | Codex | `continue`: hallazgo *major* real: `items` con huecos (`Array(1)`) no lanza `RangeError` porque `forEach` se los salta | 99 000 tokens de entrada |
| 3 · código | Claude | Validación por índice | 6 s, 2 turnos |
| Verificaciones | Automata | Las 2 aprobadas | — |
| Revisión | Codex | **`complete`**, sin hallazgos; decidió `commit: true` | 156 000 tokens de entrada |
| Git | Automata | `git add` y `git commit` → `7c9426f feat: implementar módulo y CLI de cálculo de cuenta` | automático (`ask-push`) |

**Comprobado por mí después:**
- 8 de 8 pruebas de aceptación pasan.
- `Array(1)`, `[1e21]` y `[1000000.01]` lanzan `RangeError`.
- El commit `7c9426f` contiene solo `README.md`, `src/cli.mjs` y `src/cuenta.mjs`. El árbol de trabajo quedó limpio.
- Claude retomó la misma sesión (`109d66d9`) en las 3 rondas; Codex, el mismo hilo (`01a17b30`).
- `apiKeySource: "none"` en todas las llamadas de Claude. Ningún error ni aviso de ninguna de las dos CLI.
- Quedó una pregunta final «¿Correr la app?» pendiente (no bloquea).

**Lo que cambió respecto al primer trabajo:**
1. **Criterios con límites:** de 1 a 1 000 artículos y montos de 0 a 1 000 000. Con eso, el director pudo aprobar.
2. **Restricciones que avisan del acceso limitado:** «Claude no puede ejecutar comandos; Automata ejecuta las verificaciones». Con eso, Claude no intentó correr ningún comando (0 permisos negados, contra 7 en el primero), y el director escribió «No ejecutes comandos» en su instrucción. Esto confirma el hallazgo 1: la información del permiso debería ir en el prompt del sistema, no depender de que el usuario la escriba.
3. **Sin mensajes de otros proyectos en medio.** Por eso tardó 2 min en vez de 5,5.

**Lo que este trabajo agregó a lo comprobado con agentes reales:**
- Llegar a `complete` y que las validaciones de aprobación acepten una revisión real.
- Un commit decidido por el director y ejecutado por Automata (`GitOps.commit`).
- Un segundo caso de revisión que encuentra un defecto que las pruebas no cubrían.

Después del trabajo, el acceso volvió a **completo**.

---

## Primer trabajo (bloqueado)

Fecha: 26 oct 2026, 19:18–19:24 (hora local) · Trabajo `5aa79594` · Proyecto «Paso 0 · cuenta»

## Resultado

**El ciclo corrió completo con Claude y Codex reales, de principio a fin, sin mensajes manuales entre rondas. Terminó en `blocked`, no en `complete`.**

El director bloqueó por un defecto real del criterio que escribí yo, no por una falla de Automata. El criterio 1 pide precisión al centavo «sin errores de punto flotante», pero no pone un límite a los montos. Con montos de 1e21 o más, un `Number` de JavaScript no puede representar cada centavo. Lo comprobé: `calcularCuenta({ items: [1e21], … })` devuelve `999999999999999900000`. El director pidió decidir si se limitan los montos o se cambia el formato de salida.

**Criterio de éxito del Paso 0:** llegar a `complete` con verificaciones aprobadas y evidencia para todos los criterios.
- Verificaciones aprobadas: **sí**, las 2.
- Evidencia: **sí** para 4 de los 5 criterios.
- `complete`: **no**.
- **El Paso 0 todavía no está aprobado.**

## Preparación

| Elemento | Valor |
|---|---|
| Carpeta | `C:\Users\cellh\Automata Projects\paso0-cuenta`: fuera del repositorio de Automata y fuera de `C:\proyectos` |
| Git | `git init -b main`; commit inicial `9567dd4` con solo `package.json`, `.gitignore` y la prueba de aceptación |
| Prueba de aceptación | `acceptance/cuenta.test.mjs`, 7 pruebas escritas por mí, no por los agentes. Validada antes: 7 de 7 con una implementación de referencia (fuera del proyecto) y falla sin implementación. |
| Verificación 1 | `node --test "acceptance/*.test.mjs"` |
| Verificación 2 | Huella SHA-256 de la prueba de aceptación, ignorando CRLF. Probada con `runChecks` real: pasa con la original y con su copia CRLF, y falla con una copia alterada. |
| Criterios | 5, objetivos, todos cubiertos por la prueba de aceptación |
| Cuentas | Claude: plan Max, `gocellularfix@gmail.com`. Codex: plan de ChatGPT. GitHub: `gocellularfix-a11y`. |
| Claves de API | `ANTHROPIC_API_KEY` existe en Windows y quedó fuera: las tres llamadas de Claude reportan `apiKeySource: "none"`. |
| Modelos | Claude `claude-sonnet-5-5` (razonamiento medio); Codex `gpt-6-luna` (razonamiento por defecto) |
| Acceso | **Limitado.** Lo cambié yo para que Claude no pudiera escribir fuera de la carpeta del proyecto. Claude: `acceptEdits` con las herramientas Read, Glob, Grep, Edit, Write y Git de solo lectura. Codex: `--sandbox read-only`. |
| Git del director | `ask-push`: commits automáticos; push y merge con aprobación |
| Inicio | `POST /api/start`, la misma llamada que hace el botón «Iniciar trabajo» |

## Cronología (real)

| Hora | Etapa | Quién | Qué pasó | Duración |
|---|---|---|---|---|
| 19:18:30 | Planear | Codex | Inspeccionó la carpeta y pidió un solo hito: `src/cuenta.mjs` | ~30 s |
| 19:19:00 | Ronda 1 · código | Claude | Escribió `src/cuenta.mjs`. Intentó correr las pruebas 5 veces y las 5 se le negaron (acceso limitado). | 43 s, 10 turnos |
| 19:19:45 | Verificaciones | Automata | Falla la aceptación: faltan la CLI y el README. Integridad: aprobada. | segundos |
| 19:19:48 | Ronda 2 · corrección directa (1 de 3) | Claude | Sin pasar por el director: escribió `src/cli.mjs` y `README.md` | 15 s, 4 turnos |
| 19:20:08 | *(espera)* | — | Se procesó el mensaje del Pacman del usuario, de otro proyecto, dentro del ciclo | ~2 min 50 s |
| 19:22:58 | Verificaciones | Automata | Las 2 aprobadas | segundos |
| 19:23:10 | Revisión | Codex | `continue`: hallazgo *major*: montos ≥ 1e21 rompen la conversión a `BigInt` | ~12 s |
| 19:23:18 | Ronda 3 · código | Claude | Corrigió `cuenta.mjs` y agregó `test/cuenta.test.mjs` | 17 s, 4 turnos |
| 19:23:38 | Verificaciones | Automata | Las 2 aprobadas | segundos |
| 19:23:50 | Revisión | Codex | `blocked`: precisión al centavo imposible con `Number` para montos grandes; pide una decisión de producto | ~12 s |

En total fueron unos 5 min 30 s, de los cuales casi 3 min fueron la espera por el mensaje del Pacman.

**Consumo:**
- Claude: 3 llamadas, 18 turnos. El costo que reporta (US$ 0,62) es nominal: se cobra al plan Max, no a la API.
- Codex: 3 llamadas. Tokens de entrada por llamada: 53 000, 101 000 y 158 000, la mayoría desde caché. El contexto crece en cada revisión porque la sesión se retoma.

**Estado final del proyecto, comprobado por mí:**
- 9 de 9 pruebas pasan (7 de aceptación y 2 propias de Claude).
- La CLI devuelve el JSON esperado con código 0, y con `--personas 0` sale con código 1 y explica el error en stderr.
- La prueba de aceptación está intacta.
- Sin commits nuevos: el director no decidió ninguno porque no aprobó. `README.md`, `src/` y `test/` quedaron sin confirmar.
- Todos los archivos que escribió Claude están dentro de la carpeta del proyecto.

## Qué funcionó con agentes reales y qué solo con simulaciones

### Comprobado con agentes reales en esta ejecución

| Capacidad | Evidencia |
|---|---|
| Ciclo plan → código → verificaciones → revisión, 3 rondas sin intervención | `runs/5aa79594/round-00…03` |
| Esquema de revisión estricto (`--output-schema`) con Codex real | 3 `review.json` válidos; ningún error de formato |
| Corrección directa sin director cuando fallan las verificaciones | Ronda 2: `autoFixes=1`; Claude completó la CLI y el README con la salida de la verificación |
| Retomar sesión entre rondas | Claude: misma sesión `0ebcecc5` en las 3 rondas, con prompt corto. Codex: mismo hilo `01a17b27` en las 3 llamadas. |
| Director de solo lectura | Solo ejecutó `Get-ChildItem`, `rg` y `Get-Content`; no cambió nada |
| Bitácora del codificador para el director | `round-02/watch.txt` y `round-03/watch.txt` generados y enviados |
| Acceso limitado de Claude | `permissionMode: acceptEdits`. Escribió solo dentro del proyecto; `Bash` y `PowerShell` fueron negados (7 veces en total). |
| Solo el plan | `apiKeySource: "none"` en las 3 llamadas de Claude |
| Verificaciones en PowerShell | Fallo real en la ronda 1, éxito en las rondas 2 y 3; integridad comprobada |
| Revisión que exige más que las pruebas | El director encontró un caso límite real (1e21) que la prueba de aceptación no cubría |
| `blocked` cuando falta una decisión | La revisión de la ronda 3 se detuvo con una pregunta concreta |
| «¿Correr la app?» | La revisión de la ronda 2 propuso `node src/cli.mjs …`. La pregunta quedó pendiente (no bloquea). |

### Todavía solo probado con simulaciones (o no probado)

| Capacidad | Por qué no se probó aquí |
|---|---|
| Llegar a `complete` con agentes reales | El trabajo se bloqueó antes |
| Validaciones de `complete` (evidencia por criterio, sin hallazgos importantes) con datos reales | No hubo `complete` |
| Commit, push y merge decididos por el director | El director no propuso ninguna operación de Git |
| Acceso completo en el ciclo | Se usó acceso limitado a propósito |
| Equipos de varios agentes | Se usó un agente por rol |
| Límite de rondas, pausa, detener, recuperación tras cierre | No ocurrieron |
| Vigilancia de cambios durante la revisión | Solo se activa con acceso completo |
| Errores de las CLI (límite de uso, máximo de turnos, JSON inválido) | No ocurrió ninguno |
| Correr la app desde la propuesta | La propuesta quedó sin responder |

## Errores y comportamientos observados en las CLI

- **Claude:** ningún error. Las 3 llamadas terminaron con `subtype: success`. Hubo 7 permisos negados, esperados en acceso limitado.
- **Codex:** ningún error ni aviso en las 3 llamadas. Lee los archivos con `Get-Content -Raw` sin `-Encoding UTF8`. Esa es la causa probable del falso problema de codificación de la calculadora: en este proyecto no se notó porque los archivos casi no tienen acentos.

## Hallazgos nuevos

1. **El director no sabe qué permisos tiene el codificador.** Con acceso limitado, el director le pidió a Claude que ejecutara `node --test`. Claude lo intentó 5 veces en la ronda 1 y perdió turnos. El prompt del director debería decir si el codificador puede correr comandos.
2. **La corrección directa amplía el alcance.** El director pidió un solo hito (`cuenta.mjs`), pero como la verificación global falló, la corrección directa hizo la CLI y el README sin pasar por el director. Esta vez ayudó, pero el director pierde el control de los hitos cuando las verificaciones cubren todo el objetivo.
3. **Los mensajes de otros proyectos se procesan dentro del ciclo.** El Pacman («KPOP») corrió en el punto entre la ronda 2 y sus verificaciones (`coordinator.mjs:191`). Esto no contaminó el trabajo, pero lo retrasó casi 3 minutos. Además, el Pacman corrió con el acceso limitado que yo había puesto para la prueba, y por eso Claude no pudo ejecutar `node`.
4. **El director es estricto con la letra de los criterios.** Bloqueó por montos imposibles en una cuenta de restaurante. Es correcto según el texto, pero muestra que la calidad de los criterios decide si se llega a `complete`. Esto refuerza la fase «idea → criterios» de P3: el director debería proponer los límites razonables él mismo.
5. **El contexto de Codex crece rápido.** Con la sesión retomada, cada revisión envía más tokens (de 53 000 a 158 000 en 3 llamadas). En un proyecto largo eso consume la cuota del plan. Esto refuerza P2: plan y memoria propios, y empezar sesiones nuevas cada cierto tiempo.
6. **La pregunta «¿Correr la app?» queda pendiente después de un `blocked`.** No es un problema, pero se acumula.

## Para completar el Paso 0

Recomendación: **un segundo trabajo con el criterio corregido**, en una carpeta nueva. Así se conserva la evidencia de este primero y se cumple «sin mensajes manuales». El cambio sería agregar al criterio 1 y a la prueba: «montos de 0 a 1 000 000,00 por artículo; fuera de ese rango, `RangeError`».

La otra opción, responder al director con «Al plan» y continuar este mismo trabajo, también funcionaría, pero sería un mensaje manual entre rondas.
