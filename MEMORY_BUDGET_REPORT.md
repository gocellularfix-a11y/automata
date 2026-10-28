# Presupuesto de memoria de Automata: reporte

Fecha: 27 oct 2026 · Rama: `feature/p3-idea-to-project` · Sin ensayo real, sin proyectos nuevos, sin push ni merge.

## Resumen

Automata ya tiene un **presupuesto de RAM de 30 GiB para su propio conjunto de procesos**, configurable, medido por separado de la memoria del sistema y vigilado durante cada trabajo. Es **supervisión preventiva, no un límite duro**: no inicia nada nuevo cuando no cabe, pero no cierra lo que ya corre. No toqué ni medí con intención de afectar el entrenamiento de AI-DJ, las sesiones interactivas de Claude ni ningún proceso ajeno.

## 1. Presupuesto configurado

| | |
|---|---|
| Valor | **30 720 MB (30 GiB)** |
| Dónde se cambia | Ajustes → «Presupuesto de memoria de Automata (MB)» (`ramBudgetMB`). Acepta 0 (apagado) o de 2 048 a 1 048 576 |
| Variable de entorno | `AUTOMATA_RAM_BUDGET_MB=30720` fija el valor inicial; una vez guardado en Ajustes, manda Ajustes |
| A qué se aplica | Al **árbol de procesos propio**: el proceso de Automata y todo lo que descienda de él (Claude, Codex, verificaciones, la app que corre, `git`) |
| A qué NO se aplica | Procesos que no descienden de Automata: AI-DJ, las sesiones interactivas de Claude, Chrome. No se suman ni se tocan |
| Qué se suma | Memoria física (working set) del árbol; la memoria privada se anota aparte |
| Reserva | 1 024 MB libres dentro del presupuesto para el siguiente proceso; «cerca» desde el 85 % |
| Margen para Windows y otros | Se conserva siempre: mínimo de **1 536 MB libres** y **2 048 MB de margen de memoria virtual** en el sistema (`AUTOMATA_MIN_FREE_MB`, `AUTOMATA_MIN_COMMIT_MB`) |

Con el presupuesto de 30 GiB el techo práctico lo pone, hoy, el margen del sistema (ver 2), no el presupuesto.

## 2. Consumo realmente medido

Lectura de solo lectura hecha hoy con las funciones nuevas:

| Medida | Valor |
|---|---|
| RAM total | 64 912 MB |
| RAM libre del sistema | **1 318 MB** (a media tarde estaba en 7 835 MB; con el ciclo anterior, 4 470 MB) |
| Margen de memoria virtual (commit) libre | **8 666 MB** |
| Árbol propio medido (el proceso de esta medición y sus 5 procesos) | 239 MB de RAM, 155 MB privados |
| Fuera del árbol: Python (AI-DJ) | 6 procesos, **≈ 43 GB** (llegó a ≈ 58 GB antes) |
| Fuera del árbol: sesiones interactivas de Claude | 4 procesos, ≈ 1,9 GB |
| Estado del presupuesto de 30 GiB | `ok` |
| ¿Arrancaría hoy un agente? | **No**: quedan 1 318 MB y se exigen 1 536 MB libres en el sistema |

Qué **no** tengo todavía: el consumo real del árbol de Automata con Claude y Codex trabajando. No hay ningún trabajo en curso, así que `run.memory` (los máximos por ejecución) solo se ha probado con lecturas simuladas. El ciclo real de esta noche será la primera medición verdadera; el script del ensayo ya la guarda en su reporte.

Qué se mide y se guarda por ejecución (`run.memory`, visible en el estado): máximo de RAM del árbol, de Claude y de Codex, máximo de memoria privada y de procesos, **mínimo** de RAM libre del sistema, **mínimo** de margen de memoria virtual, número de muestras, cuántas veces estuvo excedido el presupuesto y el estado actual (`off`, `ok`, `near`, `over`).

### 2.1 Medición real con agentes (28 oct, 1:36 am)

Con el entrenamiento de AI-DJ terminado (sin procesos Python, GPU en reposo, 52 683 MB de RAM libre) y con tu autorización para esa noche, se ejecutó un ciclo completo de P3 con Claude y Codex reales (detalle en `P3_STABILIZATION_REPORT.md`, sección 5.1). La corrida con el presupuesto en 61 440 MB midió, durante unos 10 minutos y 12 rondas:

| Medida | Valor real |
|---|---|
| Máximo del árbol de Automata (memoria física) | **577 MB** (868 MB de memoria privada) |
| Máximo de Claude / Codex | 308 MB / 190 MB |
| Máximo de procesos en el árbol | 13 |
| RAM libre del sistema, mínimo | 51 501 MB |
| Margen de memoria virtual libre, mínimo | 46 025 MB |
| Estado del presupuesto | `ok` en las 66 muestras de Automata, 0 excesos |

El consumo real de Automata con agentes es **menos de 1 GB**, no los 1 a 3 GB que estimé: 30 GiB es un techo muy holgado para este tipo de trabajo. Límites: es un ciclo de una idea pequeña (una página web) y 10 minutos; un proyecto grande, con pruebas pesadas o varias aplicaciones corriendo, puede consumir más. El presupuesto en 0 **desactiva la medición** además del tope: la primera corrida (con 0) no guardó `run.memory`. Para medir, conviene dejar un valor alto, no 0.

## 3. Protección preventiva

- **Antes de lanzar algo:** se comprueban (1) el margen del sistema y (2) que el árbol propio más la reserva quepa en el presupuesto. Se aplica antes de preparar o aceptar una propuesta, iniciar o continuar un trabajo, consultar a un agente, abrir **cada** agente dentro de un trabajo y ejecutar las **verificaciones**.
- **Si falta memoria:** el trabajo pasa a `waiting` («Poca memoria libre en la PC», con las cifras) y reintenta solo con la espera de P1 (30 s, 2 min, 5 min, 10 min). El plan, la memoria del proyecto, las sesiones y lo ya hecho quedan intactos. Desde la API de ideas y de arranque se responde con el motivo, sin crear nada.
- **Durante la ejecución:** cada 20 s se vuelve a medir. Al pasar a «cerca» o «excedido» se avisa una vez en la actividad. En «cerca» solo se inicia otro proceso si cabe; en «excedido» no se inicia ninguno.
- **Política segura al excederse:** informar y no iniciar procesos nuevos. La llamada de Claude o Codex en curso se deja terminar; no se pausa, no se cierra y no se reduce. El mensaje lo dice así.
- **Qué nunca hace:** cerrar o modificar procesos por memoria, tocar procesos ajenos, o tratar la lectura de memoria como una orden. La limpieza de P3 (hijos propios verificados por id, momento de inicio y programa) sigue siendo la única que cierra algo, y solo cierra lo que Automata abrió.

**Actualización del 28 oct: esto ya no es así.** Las esperas por memoria no gastan reintentos y no se rinden (ver `P3_STABILIZATION_REPORT.md`, sección 7). Lo que sigue describe el comportamiento anterior.

**Una consecuencia que debes conocer:** las esperas por memoria usan los 4 reintentos de P1 (≈ 17 minutos en total). Si el entrenamiento no libera memoria en ese tiempo, el trabajo queda en `error` con «Pulsa Continuar» y se puede continuar sin perder nada, pero **no esperaría toda la noche por sí solo**. Ver «Decisiones».

## 4. ¿Existe un límite duro?

**No.** Lo implementado es supervisión: impide empezar lo que no cabe, pero un proceso en marcha puede crecer más allá del presupuesto (Claude Code o un `npm test` con una fuga, por ejemplo) y Automata solo lo avisa. No afirmo un límite estricto.

### Job Objects de Windows: investigación

**No pude probarlo en esta máquina.** El experimento (crear un Job Object con límite de 150 MB, asignarle un proceso de prueba que pide 400 MB y ver qué ocurre) fue bloqueado por el clasificador de permisos de Claude Code por usar llamadas nativas con `ExecutionPolicy Bypass`. No lo rodeé. Lo que sigue es lo **documentado**, no verificado aquí:

- Un Job Object puede limitar la memoria **comprometida** de todos los procesos del job (`JOB_OBJECT_LIMIT_JOB_MEMORY`), y los hijos nuevos de esos procesos entran al mismo job. Es el único mecanismo de Windows que da un límite duro a un árbol.
- Node no tiene API para ello. Haría falta un ayudante (PowerShell con P/Invoke o un módulo nativo) que cree el job y le asigne el hijo **antes de que éste lance sus propios hijos**; si no, los nietos quedan fuera.
- El límite es de memoria **comprometida (privada)**, no de la memoria física que mide hoy el presupuesto; los dos números no coinciden y habría que elegir uno.
- Al superarlo, Windows no avisa al proceso: sus reservas de memoria **fallan**. Claude o Codex terminarían con un error o se caerían a mitad de una edición. Para P1 sería un fallo de salida desconocida (`unknown-exit`, tratado como pasajero y reintentado), y el trabajo parcial se aprovecharía con la continuación existente. Es compatible con la recuperación, pero con un ciclo de fallo-reintento en lugar de una espera ordenada.
- `KILL_ON_JOB_CLOSE` también resolvería de raíz los huérfanos tras un cierre brusco (hoy lo cubre el barrido por registro).
- El proceso que sostiene el job debe seguir vivo mientras dure el árbol, y la app de escritorio (Electron) añade casos que habría que probar.

**Mi recomendación:** no construirlo esta noche. Si después quieres un límite duro, que sea un job **por llamada de agente** (por ejemplo 8 GB de memoria comprometida) como red de seguridad, no como presupuesto global, y precedido de un experimento corto con tu permiso.

## 5. No interferencia

- Todo lo nuevo es lectura: `Get-CimInstance Win32_OperatingSystem` y `Win32_Process`, y `os.freemem()`. Nada cierra, pausa ni cambia prioridad, afinidad o memoria de ningún proceso.
- El árbol propio es el de Automata (descendientes de su propio proceso). AI-DJ y las sesiones de Claude ni se suman ni se tocan.
- Las pruebas que terminan procesos solo terminan los que ellas mismas lanzaron (procesos `node` de espera creados por la prueba).
- No se ejecutó el ciclo real, ni proyectos largos, ni pruebas de interfaz en Chrome.

## 6. Pruebas realizadas

`npm test`: **188 de 188** en 11 s (180 anteriores más 8 nuevas en `test/memory-budget.test.mjs`). Ligeras y deterministas: usan lecturas inyectadas, sin depender de la RAM del equipo (`test/setup.mjs` apaga el presupuesto y los mínimos salvo en las pruebas que lo prueban).

Las 8 nuevas: valor por defecto, variable de entorno y validación de Ajustes; el consumo propio solo cuenta el árbol de Automata (con un proceso tipo AI-DJ de 58 GB y una sesión interactiva de Claude en la tabla, ninguno cuenta); estados `off/ok/near/over` con reserva; separación de los tres motivos (sistema, margen virtual, presupuesto propio) y sus mensajes; el verificador reaplica un presupuesto nuevo sin releer; un trabajo con el presupuesto excedido espera, **no cierra** la llamada en curso (se comprueba que su señal de aborto nunca se activa), registra los máximos y mínimos y sigue cuando baja; presupuesto 0 no mide ni bloquea; y una lectura real y de solo lectura del árbol de la propia prueba.

Se ajustaron los textos esperados de 2 pruebas antiguas por el mensaje nuevo.

**No probado:** el campo nuevo de Ajustes en un navegador (solo sintaxis); `smoke-settings` y `smoke-plan` no se ejecutaron; el consumo real de Claude y Codex bajo Automata; Job Objects.

## 7. Pendiente para esta noche (resuelto el 28 oct: ver 2.1)

Lo siguiente se hizo la madrugada del 28 oct; se conserva como estaba escrito:


1. Cuando AI-DJ termine y haya memoria libre (el sistema debe quedar con más de 1 536 MB libres; mejor varios GB), repetir el ciclo real de estabilización. Ahora también guardará `run.memory`:
   ```powershell
   node scripts/real-idea.mjs --port 4796 --rounds 16 --idea "Quiero una calculadora de propinas: escribo el total de la cuenta y cuántas personas somos, y me dice cuánto paga cada una"
   ```
2. Con esa corrida: el `complete`, el cierre de Git en vivo, la app entregada, el máximo real de RAM del árbol de Automata, Claude y Codex, y el contexto máximo de un ciclo entero.
3. Después comparar el máximo medido con los 30 GiB y ajustar el presupuesto con datos.

## Decisiones que necesito de ti

1. **Esperas largas por memoria.** ¿Quieres que las esperas por falta de memoria no cuenten como reintentos fallidos y se repitan cada pocos minutos hasta que haya memoria? Es lo que haría falta si el trabajo debe esperar solo a que termine AI-DJ. Hoy se rinde a los ~17 minutos y espera a «Continuar».
2. **Experimento de Job Objects.** Si lo quieres, dime que lo ejecute y concédeme el permiso de PowerShell para ello; usaría 150 MB y un proceso de prueba, nada más.
3. **Mínimo de memoria libre del sistema.** Está en 1 536 MB. Con tu PC de 64 GB y AI-DJ cerca del tope, ¿prefieres un margen mayor (por ejemplo 4 096 MB) para no dejar a Windows justo?
