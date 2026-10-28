# P4 · Entrega de aplicaciones: reporte

Fecha: 28 oct 2026 · Rama: `feature/p3-idea-to-project` (sobre `70670a0`) · **Sin push, sin merge, sin agentes nuevos.**

## Veredicto

**P4 entrega y verifica una aplicación web local de extremo a extremo; Windows y Android quedan preparados, no soportados.** Con Claude y Codex reales, **una de cinco corridas** llegó a `complete` con la entrega lista y verificada por separado (la quinta, sección 6). Las otras cuatro no llegaron: una por quedarse sin rondas (mi límite era corto) y tres porque el director (Codex, de solo lectura) bloqueó pidiendo que una persona hiciera doble clic. Encontré ese defecto, lo corregí en dos pasos y la quinta corrida lo cruzó, pero **una corrida exitosa no es un porcentaje**: el director varía de una corrida a otra y no puedo demostrar que la corrección fuera la causa única del éxito.

| Pedido | Estado |
|---|---|
| Fase A: cerrar P3 | Hecho: sin cambios necesarios (sección 1) |
| Detección del entorno | Hecho, solo lectura, sin instalar nada (sección 3) |
| Entrega web local: lanzador, guía, arranque comprobado | **Hecho y probado con agentes reales una vez** |
| Windows (instalador) | **No soportado.** Se detecta si hay herramientas; no se genera ni verifica nada |
| Android (APK) | **No soportado.** Mismo caso: esta PC tiene Java, SDK y `adb`, pero Automata no compila el APK |
| Verificaciones reales (pruebas, arranque, entradas inválidas) | Hecho para web (sección 5 y 6) |
| Experiencia (listo, abrir, dónde, guía, qué funciona/pendiente) | Hecho, visto en Chrome real (sección 4) |
| Seguridad y recursos | Se mantienen (secciones 7 y 8) |

## 1. Fase A: P3

- Rama `feature/p3-idea-to-project`, cambios de P3 en commits locales (`70670a0` y anteriores); el árbol solo tenía `package-lock.json` sin versionar, a propósito.
- La **espera por RAM sin consumir reintentos de P1** ya existía y funcionaba (`70670a0`, 6 pruebas con reloj controlado): **no la reimplementé**.
- Presupuesto supervisado de 30 GiB solo para este entorno (no es requisito del producto: el árbol de Automata con agentes reales usó 551 MB como máximo en la corrida de P4). Renovación de sesiones Codex 3 / Claude 8 sin cambios.
- `npm test` estaba en 201/201 al empezar.

## 2. Diagnóstico inicial: qué había y qué faltaba

| Pieza | Existía (y se reutilizó) | Faltaba |
|---|---|---|
| Ejecutar la app | `AppRunner` y la pregunta «¿Correr la app?» | Abrir una página estática; botón «Abrir aplicación» al terminar |
| Verificar | `runChecks`; no se aprueba con verificaciones fallidas; el ciclo de corrección | Nada comprobaba que lo entregado **arranca** ni que una persona lo abra sin comandos |
| Plataforma | Campo `platform` de la propuesta (texto libre) | Interpretarlo |
| Entorno | Una frase fija («Windows, Node, Git y PowerShell») | Detección real |
| Windows/Android | `build-windows.mjs` y `build-android.ps1` empaquetan **a Automata**, no a un proyecto | Compilación genérica de proyectos de usuarios |
| Guía | Un criterio de README en la propuesta | `COMO_USAR.md` exigido y validado; panel «Tu aplicación está lista» |
| Cierre | `settleChanges` (compuerta de Git) | Compuerta equivalente para la entrega |

## 3. Qué se implementó

| Commit | Contenido |
|---|---|
| `a3629d5` | `server/environment.mjs`, `server/delivery.mjs`, `server/browsercheck.mjs` y 24 pruebas |
| `51c3543` | Compuerta de entrega en el ciclo, `run.delivery`, `/api/delivery`, 6 pruebas de flujo |
| `a86cb91` | Interfaz: fila «Tu aplicación está lista», diálogo de detalles, inglés, teléfono; `smoke-delivery` |
| `a87adb0` | Documentación (`ARCHITECTURE.md`, `README`) y verificación independiente para la prueba real |
| `47c90b9` | El director recibe la comprobación de la entrega como evidencia antes de decidir |
| `27203d4` | Esa evidencia **por partes**, en cuanto existe cada una (lanzador, guía) |
| `87e965e` | Si el director bloquea porque nadie puede abrir la página, se le devuelve **una vez** |
| `30d9a7b` | Scripts de la prueba real corregidos y este reporte |

**Entorno** (`environment.mjs`): solo lee. Detecta Windows, Node, npm, Git, PowerShell, Chrome o Edge, Java/JDK (PATH, `JAVA_HOME`, carpetas habituales y el JBR de Android Studio), Android SDK (plataforma, build-tools, `apksigner`, `d8`, `adb`), Gradle y empaquetadores globales. Las únicas consultas son versiones. `VERIFIED_TARGETS = ["web"]` separa «hay herramientas» de «Automata entrega y comprueba esto»; el director recibe ese texto al proponer. Resultado real en esta PC:

| | |
|---|---|
| Sistema | Windows 11, Node 24.19.0, Git 2.55.0, Chrome |
| Java | JDK **25.0.2** del JBR de Android Studio (no hay `JAVA_HOME` ni Java en el PATH) |
| Android SDK | `C:\Users\cellh\AppData\Local\Android\Sdk`, plataforma `android-36`, build-tools `36.0.0` con `aapt2`, `zipalign`, `apksigner`, `d8`, y `adb` |
| Gradle / empaquetador de Windows | No hay |
| Plataformas | web: lista · Android: **herramientas encontradas, entrega no soportada** · Windows: faltan herramientas (y tampoco se soporta) |

**Criterios de entrega** (`delivery.mjs`): a toda propuesta web se le añaden, con su tarea cada uno, `Abrir.cmd` (doble clic, sin comandos, nunca instala ni descarga) y `COMO_USAR.md` (Instalar, Abrir, Usar, Respaldar tus datos, Qué funciona, Qué queda pendiente). La persona los ve en la lista que aprueba junto con un aviso: «Al terminar tendrás un botón para abrirla, una carpeta con un lanzador de doble clic y una guía sencilla». Para Android o Windows la propuesta dice, antes de aprobar, que todavía no se entregan.

**Compuerta de entrega** (cuando el director aprueba): Automata comprueba por su cuenta (1) el lanzador, rechazando lo que instala, descarga, borra, cambia Windows o usa rutas absolutas; (2) la guía, con sus seis secciones con contenido y sin pedir comandos en «Abrir»; (3) la página: que exista, que cada archivo enlazado esté, que ninguna ruta empiece con `/`, que declare `<meta charset>` si tiene acentos; si necesita servidor, lo arranca de verdad, pide su página y lo detiene; (4) abre la página en el Chrome o Edge de la PC, sin ventana, y falla ante un error de programa, un recurso que no carga o una página en blanco. Si algo falla, la aprobación se convierte en una tarea para Claude con el motivo exacto (hasta 3 intentos; después `blocked` con el motivo). Solo aplica a proyectos nuevos con los criterios de entrega; los anteriores no cambian.

## 4. Lo que ve la persona

Al quedar lista, la barra pasa a llamarse «Entrega» y muestra **Tu aplicación está lista · Se guardó en `<carpeta>`** con **Abrir aplicación**, **Guía y detalles** y **Abrir carpeta**. Los detalles explican, sin jerga: dónde está y cómo abrirla, qué funciona (los criterios con su evidencia), qué queda pendiente (limitaciones que aceptó al aprobar, observaciones y que las pruebas no garantizan calidad comercial), la guía completa y, en un desplegable, cómo se comprobó. Abrir aplicación y Abrir carpeta solo desde la propia PC; la guía se lee desde cualquier dispositivo (en el teléfono, solo la guía). No vuelve a preguntar «¿Correr la app?». Capturas en `artifacts/smoke-delivery-*` y, de la corrida real, `artifacts/real-idea-2026-10-28T20-44-16-580Z/05…07*.png`. Inglés y teléfono (390 px) comprobados; en el teléfono los botones pasan debajo del texto (un desborde que `smoke-delivery` encontró y corregí).

## 5. Pruebas deterministas

`npm test`: **236 de 236** (201 al empezar, +35): `environment` 9, `delivery` 15, `delivery-flow` 9, `real-delivery-checks` 2. Cubren: detección en una PC construida en una carpeta temporal (sin depender de lo instalado), el lanzador y la guía (casos buenos y malos), referencias rotas, codificación, arranque real de un servidor local (se cierra al arrancar, no responde, otro puerto, puerto ocupado), la apertura en un Chrome real (página buena; un módulo por `file://`, un script roto y una página en blanco se detectan; no deja procesos ni perfiles temporales), el ciclo completo con agentes simulados que escriben archivos reales (aprobación devuelta → corregida → lista; 3 intentos fallidos → `blocked` → Continuar), proyectos anteriores sin cambios, Android/Windows sin compuerta, abrir una app con servidor desde el botón, la evidencia por partes para el director y la re-pregunta por bloqueos (con las tres frases reales).

Interfaz en Chrome real: **`smoke-delivery` 37/37** (propuesta con aviso, devolución del primer intento, fila, detalles con la guía, abrir página y carpeta, inglés, teléfono, sin errores ni peticiones externas); de regresión: `smoke-ideas` 27/27, `smoke-git` 20/20, `smoke-plan` 18/18, `smoke-waiting` 12/12, `smoke` y `smoke-settings` en verde.

## 6. Pruebas reales con Claude y Codex (sin supervisión)

Script: `node scripts/real-idea.mjs --port 4798 --rounds 30 --idea "Quiero una página para llevar mis gastos del mes…"`. Segunda instancia con datos propios, acceso limitado, Git local `ask-push`. **Cinco corridas, mismas condiciones salvo lo que se corrigió entre ellas:**

| # | Resultado | Qué pasó | Qué hice |
|---|---|---|---|
| 1 | `limit`, ronda 16, 9/12 | Mi límite (16 rondas) era corto para 12 tareas; el director pidió una comprobación de `localStorage` en navegador real | Subí a 30 rondas |
| 2 | `blocked`, ronda 19, 9/11 | Claude escribió bien `Abrir.cmd` y la guía; el **director** bloqueó: quería ver el doble clic y no puede ejecutarlo. Mi compuerta nunca corrió (solo corría tras aprobar) | La comprobación pasa a ser **evidencia para el director** en la etapa de verificaciones (`47c90b9`) |
| 3 | `blocked`, ronda 19, 10/12 | Igual, pero el director revisa `Abrir.cmd` (tarea 10) **antes** de que exista la guía (tarea 11); mi evidencia pedía los dos archivos | Evidencia **por partes**, en cuanto existe cada una |
| 4 | `blocked`, ronda 8, 1/10 | Mismo patrón en una tarea cualquiera: «falta que alguien abra index.html y confirme» | Re-pregunta **una vez** si bloquea por eso; si insiste, vale su bloqueo |
| 5 | **`complete`, ronda 13, 10/10** | Entrega lista a la primera comprobación | — |

**Corrida 5 (11 min 18 s):** propuesta en 27 s (9 criterios, 10 tareas); 2 intervenciones de la persona (escribir la idea y «Crear y empezar»). Claude 13 llamadas (contexto máx. 119 337, 8 rondas por sesión), Codex 18 llamadas (contexto máx. 52 102 de 258 400; sesiones de 3 rondas). 10 commits locales hechos por el flujo, árbol limpio, sin remoto, push ni merge; los otros proyectos intactos; sin procesos residuales de Automata.

Lo que verifiqué **aparte de Automata** (`scripts/real-idea.mjs` + `real-delivery-checks.mjs`):
- `Abrir.cmd` = `@echo off` + `start "" "%~dp0index.html"`; `COMO_USAR.md` de 4 540 caracteres con las seis secciones; ambos **guardados en Git** (los dos aparecen en `git ls-files`).
- La compuerta de Automata pasó en la ronda 13 a la primera, con Chrome real abierto sobre la página («Gastos del mes», 6 controles, sin errores). La fila «Tu aplicación está lista», sus tres botones y el diálogo con la guía se vieron en Chrome.
- **La app, usada a mano en Chrome por `file://`** (script aparte, no el del ciclo): guardar un gasto de 45,50 lo muestra y el total pasa a 45,50; **al recargar la página el gasto sigue ahí** (`localStorage` funciona con doble clic); importes `abc`, `0` y `-5` muestran un aviso y no guardan nada; cero errores de página. 58 pruebas del proyecto pasan (las corrió Automata; ver límites).
- Evidencia de que mi corrección se usó: en la ronda 11 el prompt del director trae «ENTREGA (la comprobó Automata en la ronda 11: el lanzador Abrir.cmd y el arranque real, abriendo la página en un navegador): correcta», y el director aprobó la tarea citando que Automata lo comprobó, sin bloquear.
- Memoria: máximo del árbol de Automata **551 MB** (Claude 355, Codex 188), 10 procesos; libre del sistema mínimo 44 900 MB. El Chrome de la prueba llegó a 1 297 MB y no es de Automata.

**El script marcó `ok: false` en esa corrida por una limitación suya**, no del producto: el director ofreció como comando `Abrir.cmd`, y mi comprobación vieja de «la app respondió» no sabía interpretar un lanzador. Lo corregí (`checkStaticPage` ahora lee el lanzador y comprueba la página que abre; con prueba) y **recalculé el veredicto sobre el mismo informe: las 13 condiciones se cumplen**. No volví a correr los agentes para esto.

## 7. Seguridad

No se publica nada ni se hace push ni merge (los proyectos de la prueba no tienen remoto). Automata no instala herramientas: solo lee versiones y avisa lo que falta. El lanzador no puede instalar, descargar, borrar ni tocar Windows (se rechaza, con prueba). Abrir aplicación y Abrir carpeta solo responden a la propia PC; en el teléfono solo se lee la guía. No se instala ningún APK en ningún teléfono. Se conservan los permisos y el aislamiento de P1/P2/P3 (carpeta propia, sin cambios de configuración global) y solo existen los dos agentes. Para abrir una página en pantalla se usa `explorer.exe` sobre un archivo de la carpeta del proyecto (verificado dentro de ella); nunca se ejecuta el lanzador ni el archivo.

## 8. Recursos

Nada se ejecuta en paralelo con otro trabajo pesado: la compuerta y la evidencia piden primero la comprobación de memoria de siempre (si falta, el trabajo espera sin gastar reintentos, como en P3). Chrome se abre ~1 s por comprobación y se cierra con su perfil. Las pruebas reales corrieron de una en una con 44-49 GB libres, sin tocar tus sesiones de Claude ni el `vitest` de `cellhub-license-cloud` que arrancó durante una corrida (mi script lo contó como «resto» por su nombre; no es de Automata). Sin sistemas nuevos de administración de RAM.

## 9. Limitaciones y lo que no se probó

- **Solo web local.** No hay instalador de Windows ni APK, y **no se declara soporte**. Esta PC tiene Java 25, SDK 36 y `adb`, pero `build-android.ps1` compila con `-source 8` y JDK 21 (ver memoria del proyecto): con Java 25 **no está comprobado** que funcione.
- **Una sola corrida real exitosa**, con una idea y una app estática. No se probó con agentes reales una app con servidor local (sí con servidores de prueba), ni proyectos grandes, ni inglés con agentes reales.
- **Nunca se ejecutó `Abrir.cmd` de verdad**: abriría una ventana en tu pantalla. Se lee, se valida y se abre en un Chrome sin ventana la página que abre; el botón «Abrir aplicación» se probó con un registrador, no con `explorer.exe` real.
- **El director es variable.** 3 de 5 corridas se bloquearon por lo mismo. La re-pregunta usa una expresión regular (puede equivocarse en ambos sentidos: cuesta, como mucho, una consulta extra) y **no llegó a usarse en la corrida exitosa**, así que su efecto con agentes reales no está medido; lo cubren las pruebas con las frases reales.
- **Calidad de la guía**: se valida su estructura (seis secciones con contenido, «Abrir» sin comandos), no que lo escrito sea cierto ni claro. Las pruebas aprobadas no son calidad comercial, y el reporte de la app lo dice.
- **Claude no pudo ejecutar `node --test`** en toda la corrida (acceso limitado: el comando pedía aprobación); las 58 pruebas las corrió Automata. El director gastó ~3 rondas en un «texto corrupto» de `COMO_USAR.md` que era el falso problema conocido de PowerShell 5.1 mostrando UTF-8 (ya está en la memoria del proyecto desde P2; no lo toqué).
- Los problemas de entrega que se le devuelven a Claude están en español aunque el idioma sea inglés (la interfaz y los avisos fijos sí se traducen).
- La comprobación en navegador necesita Chrome o Edge; sin ellos se dice y se revisan solo los archivos y el arranque.
- No se ejecutaron `smoke-recovery`, `smoke-desktop`, `smoke-console` ni `smoke-phone` (Electron, `.exe`, teléfono por `adb`); `smoke-recovery` ya fallaba al abrir la ventana nativa en esta PC antes de P4.
- Las carpetas de las cinco corridas (`gastos-del-mes` a `gastos-del-mes-5` en `C:\Users\cellh\Automata Projects`) quedan como evidencia; no las borré.

## 10. Cómo repetirlo

```powershell
node scripts/real-idea.mjs --port 4798 --rounds 30 --idea "Quiero una página para llevar mis gastos del mes: anoto cuánto gasté y en qué, y me muestra el total del mes y cuánto llevo en cada categoría"
node scripts/smoke-delivery.mjs
npm test
```

## Decisiones que necesito de ti

1. **Aprobar el cierre de P3 y de P4** (rama `feature/p3-idea-to-project`, sin push ni merge) o indicar qué falta. No hago push ni merge hasta tu autorización.
2. **¿Seguimos con Android?** Es el siguiente paso natural (esta PC tiene las herramientas), pero exige primero probar `build-android.ps1` con Java 25 o fijar el JDK 21; hoy no declaro soporte.
3. **¿Acceso completo para Claude en los proyectos de ideas?** Con acceso limitado no puede ejecutar sus propias pruebas y el director lo percibe como falta de evidencia; es una de las causas de los bloqueos.
4. **¿Borro las cinco carpetas de prueba** (`gastos-del-mes` … `-5`) o las dejas como evidencia?
5. Siguen abiertas las del reporte de P3 (la 5 y la 7 a la 9).
