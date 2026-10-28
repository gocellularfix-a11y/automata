# P4 · Estabilización de la entrega web: reporte

Fecha: 28 oct 2026 · Rama: `feature/p3-idea-to-project` (sobre `d8f8f42`) · **Sin push, sin merge. Android no se tocó. Sin agentes nuevos, sin dependencias nuevas, sin cambios a la configuración global de Claude ni de Codex.**

## Veredicto

Las tres corridas que terminaron `blocked` tenían la misma raíz: **el director (solo lectura) pedía que una persona hiciera algo que Automata sí puede ejecutar**, y Claude (acceso limitado) no podía ejecutar ni siquiera `node --test`, así que el director no veía evidencia. Ahora:

- el director recibe cada ronda una sección **COMPROBACIONES DE AUTOMATA** (pruebas con conteo, arranque, recursos cargados, errores del navegador, escenarios de interfaz, codificación), cada área con su estado, incluido «NO SE PUDO COMPROBAR»;
- un bloqueo «que alguien abra/pruebe a mano» se le devuelve **dos veces** con lo que Automata ya comprobó; si insiste, pasa a ser **una tarea para Claude** (máx. 2 por trabajo), nunca una aprobación, y los bloqueos de decisiones, secretos, pagos o publicaciones no se tocan;
- Claude sigue con acceso limitado y corre las verificaciones aprobadas del proyecto **a través del coordinador**;
- la interfaz de escritorio tenía un defecto real que ningún test cubría: **«Abrir aplicación», «Abrir carpeta» y «Guía y detalles» fallaban con «Ruta no permitida»**. Reproducido con la ventana de Electron real y corregido.

**Qué NO puedo afirmar:** una corrida real nueva llegó a `complete` sin intervención, pero **una corrida no es un porcentaje**. El director varía; en esa corrida nunca bloqueó, así que **la ruta «reenviar y convertir en tarea» no se ejercitó con agentes reales** (sí con las tres frases reales, en pruebas). Windows y Android siguen sin declararse.

| Prioridad | Estado |
|---|---|
| 1 Evitar bloqueos innecesarios | Hecho; probado con las 3 evidencias reales (repetición) y 1 corrida real nueva |
| 2 Permisos | Hecho; probado con Claude real |
| 3 Codificación UTF-8 / PowerShell 5.1 | Causa demostrada; lectura byte a byte + aviso al director |
| 4 Entrega web | Defecto real del escritorio encontrado y corregido; mensajes traducidos |
| 5 Validación | `npm test` 280/280, `smoke-delivery` 37/37, `smoke-desktop` ok, 1 corrida real |

## 1. Investigación de los tres bloqueos (evidencia, no suposición)

Datos: `review.json`, `check-*.json` y `code-coder.jsonl` de las corridas 2–4 (`artifacts/real-idea-2026-10-28T20-05…`, `T20-21…`, `T20-36…`). Fixture: `test/fixtures/real-blocks.json`.

| Corrida | Qué dijo el director | Qué había en realidad |
|---|---|---|
| 2 (T10) | «no se ha comprobado que abra la aplicación… requiere doble clic… intentos rechazados» | Lanzador y guía correctos, 32/32 pruebas |
| 3 (T11) | «alguien pueda hacer doble clic en Abrir.cmd y confirmar» | 14/14 pruebas, página sin errores |
| 4 (T2) | «falta que alguien abra index.html, guarde el gasto de prueba y confirme» | 10/10 pruebas de lógica; **ninguna de interfaz** |

Lo que Claude intentó y su permiso rechazó en esas corridas (mismo script de análisis): `node --test tests/…` (17 intentos en la corrida 3, 6 en la 4, 11 en la 5), `Start-Process Abrir.cmd`, `cmd /c Abrir.cmd`. Es decir, gastó turnos en lo que su permiso no permite y lo informó como bloqueo, y el director lo leyó como falta de evidencia.

**Reproducción** (`scripts/replay-blocks.mjs`, sin agentes): con las carpetas que dejaron esas corridas, Automata habría mostrado al director, en el momento del bloqueo: pruebas 32/32, 14/14, 10/10; página abierta en Chrome sin ventana; 4 de 4 archivos cargados; sin errores del navegador; codificación correcta. Para las tres, `classifyBlock` da «pide a una persona repetir algo que Automata hizo» (cubierto: pruebas, arranque, lanzador). Solo la corrida 4 pedía además algo que **no** estaba cubierto —la interfaz—, y para eso existe ahora el camino de escenarios.

## 2. Qué se hizo (commits locales, sin push)

| Commit | Contenido |
|---|---|
| `763d6ef` | Módulos: `evidence.mjs`, `scenarios.mjs` + `browsercheck.mjs` (escenarios en navegador real), `humancheck.mjs`, `textcheck.mjs`, mensajes de `delivery.mjs` en el idioma configurado; 36 pruebas |
| `1dfe569` | Conexión al coordinador, política de bloqueos, herramienta de verificación para Claude (`agenttools.mjs`, endpoint local), prompts, interfaz |
| `0dc9aec` | Corrección del puente de escritorio + `desktop-routes.test.mjs` + scripts `smoke-open-app.mjs` y `replay-blocks.mjs` |

### 2.1 Evidencia estructurada para el director
Cada ronda (etapa de verificaciones) Automata reúne: **PRUEBAS** (comando, `x de y` pasan; se entiende `node --test`, TAP y jest), **ARRANQUE** (la página se abrió en Chrome/Edge sin ventana), **RECURSOS** (`n de m` archivos cargaron, cuáles fallaron), **ERRORES DEL NAVEGADOR** (excepciones, `console.error`, recursos fallidos), **INTERFAZ** (escenarios) y **CODIFICACIÓN**. Una área que no se ejecutó dice «NO SE PUDO COMPROBAR» o «SIN ESCENARIOS»; nunca figura como correcta. Antes de que exista el lanzador ya se abre `index.html` (la corrida 4 bloqueó antes de que existiera). Se reutilizan las comprobaciones existentes (`runChecks`, `verifyDelivery`, `checkInBrowser`); las verificaciones del proyecto no cambian de tamaño.

### 2.2 Qué puede ejecutar Automata y qué requiere a una persona
- **Automata ejecuta:** pruebas del proyecto, arranque, carga de recursos, errores del navegador, pasos de interfaz (`ui-check.json`: escribir, elegir, pulsar, recargar, comprobar texto/valor/conteo, con datos aislados por escenario), lectura de codificación.
- **Requiere a una persona:** decisiones (moneda, alcance), datos o credenciales, pagos, publicación, borrar datos reales; y mirar la pantalla **cuando no hay navegador en la PC** (entonces el bloqueo se respeta; es el único caso en que Automata no puede sustituir a la persona).
- `ui-check.json` es un formato declarativo validado (12 escenarios, 40 pasos, acciones de una lista corta): no ejecuta código del proyecto fuera del navegador de prueba. Claude lo conoce por su prompt; en la corrida real lo escribió solo.

### 2.3 Política de bloqueos (`humancheck.mjs` + `coordinator.review`)
Bloqueo del director que pide abrir/probar a mano, página web **con navegador disponible**:
1. intentos 1 y 2: se le devuelve con lo que Automata ya comprobó y cómo producir lo que falta;
2. intento 3: se convierte en `continue` con una tarea para Claude (jamás `complete`); las marcas `blocked` del plan se retiran; la tarea que nombró el director se mantiene (si no puede recibir el trabajo, el bloqueo se respeta, probado);
3. máximo 2 conversiones por trabajo; después el bloqueo vale y decide la persona;
4. sin navegador, en proyectos que no son web, o si el texto toca decisiones/credenciales/pagos/publicación/borrado: una sola devolución y decide la persona (como antes).
No se aprueba nada automáticamente y los criterios sin evidencia siguen sin cumplirse.

### 2.4 Permisos (Prioridad 2)
Claude conserva `acceptEdits` y su lista de herramientas; solo se añade **un comando literal**: `Bash(node <tmp>/automata-tools/automata-check.mjs)`. El script no acepta argumentos; pide al coordinador, por loopback y con un token que existe durante esa llamada, que ejecute con la misma función `runChecks` **las verificaciones que la persona aprobó** en la propuesta. Límites: solo desde esta PC, nunca desde una página (rechaza `Origin`), un token por llamada de Claude y por trabajo, una verificación a la vez, 8 por tarea, respeta el chequeo de memoria. Con acceso completo no se usa. No se tocó ninguna configuración global.
- **Probado con Claude real** (`scripts/real-agent-checks.mjs`, Haiku): ejecutó el comando, pasó por el coordinador (carpeta `claude-checks-1`) y recibió 3/3 pruebas; en una prueba aparte con la CLI real, `node --test` y una ruta con espacios fueron rechazados con esa misma regla.
- **Hallazgo honesto:** Claude Code permite por sí mismo algunos comandos de solo lectura (`ls`, `find`); eso no lo cambié ni lo amplié.

### 2.5 Codificación (Prioridad 3)
Causa demostrada en el entorno real (PowerShell 5.1.26100): `Get-Content` sin `-Encoding` lee UTF-8 como ANSI y muestra «CÃ³mo» para un `COMO_USAR.md` que es UTF-8 válido; con `-Encoding UTF8`, o con `node`, se lee «Cómo». Los 7 proyectos entregados (corridas 1–5 y calculadoras) tienen **cero problemas reales**. Cambios: `textcheck.mjs` lee los bytes y solo marca error real si el archivo no es UTF-8, tiene `�`, está guardado dos veces mal (`Ã³`), tiene BOM en un `.json` o acentos en `Abrir.cmd` sin `chcp 65001` (cmd.exe los mostraría rotos de verdad); el director recibe CODIFICACIÓN con el resultado y, en sus reglas (una vez por sesión), cómo leer sin falsa alarma; a Claude se le dice que no «corrija» archivos que están bien. **No se modificó ningún archivo correcto.**

### 2.6 Entrega web (Prioridad 4)
- **Defecto real encontrado:** el puente de `desktop/main.cjs` no incluía `delivery` ni `app` (esta última, el botón de detener la app, también). Reproducido con la ventana de Electron real: *«Error invoking remote method 'automata:request': Error: Ruta no permitida.»* en los tres botones. Corregido (`"app", "delivery"`). `smoke-open-app.mjs`, tras la corrección, con el sistema real: el Chrome real mostró «AUTOMATA-ABRIR-… – Google Chrome», el Explorador abrió la carpeta y la guía cargó. `desktop-routes.test.mjs` compara las rutas de la interfaz con las del puente y **falla sin la corrección** (verificado). Se mantienen las comprobaciones de seguridad: el puente sigue exigiendo la ventana de Automata y rutas con nombre; abrir solo desde loopback; el lanzador no se ejecuta jamás.
- **Mensajes en el idioma configurado:** lanzador, guía, página, arranque del servidor, escenarios, eventos de la compuerta, la orden a Claude (`deliveryFixPrompt`) y la evidencia del director salen en español o inglés (pruebas en ambos idiomas); la interfaz traduce el nuevo paso «escenarios».

## 3. Validación

| | Resultado |
|---|---|
| `npm test` | **280/280** (236 al empezar; +44: `evidence` 7, `textcheck` 5, `scenarios` 6, `humancheck` 7, `agent-checks` 8, `desktop-routes` 3, `delivery-flow` +7, `delivery` +1) |
| `smoke-delivery` | **37/37** |
| `smoke-desktop` | ok (ventana Electron) |
| `smoke-open-app` | ok tras la corrección; **falló antes** (Ruta no permitida ×3) |
| Pruebas con Chrome real | escenarios (guardar, recargar y conservar, aislamiento, importe inválido, `alert()`, recurso faltante), sobre páginas de prueba y sobre una copia de la app entregada en la corrida 5 |
| No ejecutados | `smoke-recovery` (ya fallaba al abrir la ventana nativa), `smoke-console`, `smoke-phone` |

Una de las pruebas de `delivery.test` (servidor local de prueba) falló una vez dentro de la suite completa y pasó en las siguientes ejecuciones; no la investigué a fondo (posible sensibilidad a carga).

## 4. Una corrida real nueva (sí aportaba evidencia que no se simula)

`scripts/real-idea.mjs --port 4798 --rounds 30` (misma idea de los gastos del mes), Claude y Codex reales, acceso limitado. **`complete` en la ronda 12, 10/10 tareas, 15 min, 2 intervenciones de la persona** (escribir la idea y «Crear y empezar»); `report.ok = true`; carpeta `gastos-del-mes-6`.
- Claude usó la herramienta del coordinador **13 veces** (13 carpetas `claude-checks-N`); sus comandos rechazados bajaron a 2 (uno de un `cat >` por shell, uno que fue una verificación que falló legítimamente). Antes: 6–17 intentos fallidos de `node --test` por corrida.
- Claude **escribió solo `ui-check.json`** con 11 escenarios (registrar, consultar por mes, importe inválido…); uno falló, Claude corrigió el paso, y el director aprobó citando «Automata confirmó los 11 escenarios en un navegador real».
- El director **no bloqueó ninguna vez** (12 `continue` y 1 `complete`). Por eso la conversión de bloqueos no se vio actuar con agentes reales.
- Entrega comprobada en la ronda 12 (lanzador, guía, arranque real); árbol de Automata: pico 789 MB; el Chrome de la prueba llegó a 1 583 MB.
- Límites: sigue siendo **una** corrida; mismo tipo de app (página estática); ningún falso «texto corrupto» apareció, pero tampoco puedo demostrar que la nota de lectura fuera la causa. Los «restos» que marca el script son `conhost.exe` de las propias herramientas (falso positivo ya conocido del script, no de Automata).

## 5. Limitaciones y riesgos

- **Variabilidad del director:** la política está probada con las frases reales y flujos simulados, no con un director real que insista.
- **Heurística de bloqueos por expresión regular:** puede equivocarse en ambos sentidos; el peor caso son dos consultas extra, o un bloqueo legítimo no reconocido como tal (nunca una aprobación). Los marcadores de «sensible» son una lista corta.
- **Los escenarios prueban lo que Claude escribe:** un escenario flojo da evidencia floja; el director debe compararlo con el criterio (la evidencia se lo pide), y no se valida su calidad.
- **El permiso extra depende de que `%TEMP%` no tenga espacios** (la regla de permiso es literal); si los tiene, Claude solo recibe la orden de esperar a Automata.
- Apps con **servidor local** abiertas desde la ventana de escritorio no se probaron con el sistema real (solo la ruta de archivo estática y el coordinador por separado).
- El smoke real **dejó una pestaña de Chrome abierta** (título «AUTOMATA-ABRIR-…», apunta a una carpeta temporal ya borrada): puedes cerrarla. Cerré solo la ventana del Explorador que abrí.
- Siguen sin soporte Windows (instalador) ni Android.

## 6. Cómo repetirlo

```powershell
npm test
node scripts/smoke-delivery.mjs
node scripts/smoke-open-app.mjs              # abre una pestaña y una ventana reales
node scripts/replay-blocks.mjs               # reproduce los 3 bloqueos con las carpetas guardadas
node scripts/real-agent-checks.mjs           # un llamado real a Claude (Haiku)
```

## Decisiones que necesito de ti

1. **¿Cierro P3 y P4 (incluida esta estabilización) para publicar?** No hago push ni merge hasta tu autorización.
2. **¿Android ahora?** La estabilización no lo requería; sigue pendiente probar `build-android.ps1` con Java 25 o fijar el JDK 21.
3. **¿Una segunda corrida real con una app con servidor local?** Es el hueco que más evidencia daría; no la forcé.
4. **Carpetas de prueba** (`gastos-del-mes` … `-6`): ¿las borro o quedan como evidencia?
