# P4 · Cierre de web: reporte final

Fecha: 28 oct 2026 · Rama `feature/p3-idea-to-project` · **Sin push, sin merge. Carpetas de evidencia conservadas. Android: solo auditoría y plan (`ANDROID_DELIVERY_PLAN.md`); no se implementó nada.**

## 1. Estado de Git

- Rama `feature/p3-idea-to-project`, árbol limpio salvo `package-lock.json` sin versionar (a propósito, como en P3/P4).
- Commits de esta etapa y de la anterior sobre `d8f8f42` (todos locales):

| Commit | Contenido |
|---|---|
| `763d6ef` | Módulos de evidencia, escenarios, clasificación de bloqueos, codificación |
| `1dfe569` | Conexión al coordinador, política de bloqueos, herramienta de verificación para Claude |
| `0dc9aec` | Corrección del puente de escritorio (Ruta no permitida) |
| `60a67f0` | Reporte de estabilización |
| `3a27c50` | Herramienta de verificación con carpetas con espacios; prueba de servidor; `smoke-open-server-app` |
| `a73534a` | Limpieza de pruebas que corren servidores y escenarios más robustos |
| (este) | Plan Android y este reporte |

## 2. La prueba intermitente de `delivery.test` (investigada con evidencia)

Fallaba «una app con servidor se arranca de verdad…». **No supuse que fuera carga**: intenté reproducirla y, al reaparecer, guardé la salida de la suite.

- **Intentos de reproducción:** 25 ejecuciones aisladas, 20 con 16 procesos que saturaban la CPU y 4 copias en paralelo, 1 suite con carga concurrente (suite + `smoke-delivery` + 8 procesos de carga), y 3 + 3 suites completas: **0 fallos**. Dos experimentos aparte (matar el servidor, directamente y a través del ejecutor de apps con PowerShell, y borrar la carpeta al instante): 0 de 55.
- **Captura real** (2 de 8 suites completas): *el cuerpo de la prueba pasó*; lo que falla es su **limpieza**: `EPERM, Permission denied: …\automata-delivery-XXXX` al borrar la carpeta temporal del proyecto, ~1.1 s después de empezar. No es una aserción del producto.
- **Mecanismo demostrado** (`test/rmretry.test.mjs`): una carpeta que es el directorio de trabajo de un proceso vivo no se puede borrar en Windows (`EPERM`/`EBUSY`) hasta que el proceso termina. Cuándo el sistema libera la carpeta tras detener el servidor varía, y no pude provocar ese retraso a voluntad.
- **Mi primera corrección no funcionó**, y la suite me lo mostró: `fs.rmSync(…, { maxRetries })` **no reintenta** en este Node (el fallo siguió apareciendo en ~1 s). Lo sustituí por `test/rmretry.mjs` (reintenta hasta 6 s solo ante bloqueos), usado en las pruebas que arrancan servidores.
- Además: el puerto de la prueba ahora se comprueba antes de usarlo y, si vuelve a fallar una aserción, el mensaje incluye lo que vio la comprobación.
- **Lo que no puedo afirmar:** que la causa de *todas* las apariciones sea esta limpieza; solo está capturada la de 2 apariciones. Resultado tras la corrección: ver sección 8.
- **Otro intermitente, sin explicar:** «la detección de restos funciona con la tabla de procesos real» (`real-idea-checks.test`) falló **una** vez en suite completa y pasó 20 de 20 aisladas y en todas las suites siguientes. No guardé su salida; no tengo causa. Queda anotado, sin cambios.
- **Un tercero, esta vez sí con causa:** una prueba de escenarios con Chrome real falló una vez bajo carga (8 s): el `click` llegó a una página que aún no terminaba de cargar y el formulario se envió de forma nativa. Corregido en el producto, no solo en la prueba: los escenarios ahora esperan a `document.readyState === "complete"` y reintentan las expectativas hasta 2 s (como una persona que espera a que aparezca algo); hay una prueba con renderizado retrasado.

## 3. Permiso de la herramienta de verificación sin depender de rutas sin espacios

Antes: si `%TEMP%` tenía espacios, Claude solo recibía «espera a Automata». Ahora (`agenttools.mjs`): la carpeta con espacios se usa **por su nombre corto de Windows (8.3)**, comprobando que resuelve a la misma carpeta; si no hay 8.3 se prueba otra carpeta (`~/.automata`); si ninguna sirve, no se promete herramienta (como antes). La autorización sigue siendo **un único comando literal** sin argumentos (`Bash(node <ruta>)`), token por llamada, solo loopback, máx. 8 por tarea.
- **Probado con Claude real** con `TEMP` apuntando a una carpeta con espacios (`…\dir with space`): el comando salió con nombre corto (`…/DIRWIT~1/AUTOMA~2/automata-check.mjs`), Claude lo ejecutó, las 3/3 pruebas pasaron por el coordinador y `node --test` siguió **rechazado**.
- Pruebas deterministas: nombre corto válido, nombre que lleva a otra carpeta (se descarta), nombre que aún tiene espacios, ninguna carpeta válida.

## 4. Electron real: aplicación web con servidor local (`scripts/smoke-open-server-app.mjs`)

Ventana de escritorio real, sistema real, una app Node de prueba con su `Abrir.cmd`, dentro de una copia de una corrida entregada (título y carpeta propios, puerto elegido por el sistema):

| Paso | Resultado |
|---|---|
| Antes de empezar | nada escucha en el puerto |
| «Abrir aplicación» | aviso «Abriendo la aplicación en tu navegador»; el servidor **arrancó y responde**; dos procesos (el PowerShell y el `node`) identificados por el puerto |
| Navegador | el Chrome real abrió una pestaña titulada con el título único de la app |
| Fila APP | «En marcha · node server.mjs · http://localhost:PUERTO» con botón **Detener** |
| «Detener» | el servidor deja de responder y **los dos procesos desaparecen** |
| Abrir de nuevo y **cerrar Automata sin detener** | el servidor se detiene al cerrar y **no queda ningún proceso** (ni del servidor ni de Electron) |

Veredicto del script: 5 de 5. Corregí además mi propia medición (la primera versión contaba el PowerShell de la consulta como «residuo»). Efectos en tu pantalla: quedaron **2 pestañas de Chrome abiertas** (apuntan a puertos ya cerrados) y, de la prueba de la etapa anterior, otra; puedes cerrarlas.

## 5. Controles de Git y de seguridad existentes

| Control | Resultado |
|---|---|
| `smoke-git` (Chrome real: commits, push/merge pendientes, aprobaciones) | **20/20** |
| `smoke-access` (acceso limitado/completo, solo lectura) | ok |
| `smoke-auth` (código de acceso, cuentas) | ok |
| `smoke-settings` | ok |
| Pruebas de `git`, compuerta de Git, `safety`, `access`, `auth` dentro de `npm test` | en verde |
| El nuevo endpoint local | solo loopback, nunca desde una página (rechaza `Origin`), token por llamada: 401/403/401 comprobados por HTTP real |
| `audit-secrets` (solo lectura) sobre tu espacio de trabajo real (`AppData\Roaming\Automata\workspace`, 142 archivos) | **16 archivos con coincidencias** del patrón «asignación, contraseña en URL o cadena de alta entropía», todos registros de conversación (`*.jsonl`) con vista previa redactada. No modifiqué nada; no analicé si son secretos reales o firmas de razonamiento. Si quieres, el script puede poner esos registros en cuarentena (`--quarantine`) |
| `smoke-access` dejó un `last-invocation.json` suelto en la raíz del repositorio | lo borré; es un efecto conocido de ese script, no de Automata |

## 6. Pruebas pertinentes

- `npm test`: ver sección 8 (285 pruebas; +2 de `rmretry`, +1 de escenarios, +2 de `agent-checks`, desde 280).
- `smoke-delivery` 37/37; `smoke-desktop` ok; `smoke-open-app` (página estática, escritorio real) ok; `smoke-open-server-app` (servidor local, escritorio real) 5/5.
- Una sola corrida real de agentes en la etapa anterior; **en esta no hice ninguna más**: lo que faltaba (servidor local desde el escritorio) lo demostró una prueba acotada.

## 7. Android (Etapa 2): lo que se hizo y lo que no

Solo auditoría y plan, en `ANDROID_DELIVERY_PLAN.md`. Hallazgos que cambian decisiones: JDK 25 solo funciona con Gradle 9.x (con 8.x falla de verdad, aunque `gradle --version` responde); se construyó un APK real **sin descargar nada** con Gradle 8.14.3 + AGP 8.13.0 + JDK 21 usando la caché del usuario en modo solo lectura; el camino sin Gradle (`aapt2 → javac --release 8 → d8 → apksigner`) funciona con JDK 21 y 25; hay teléfono autorizado (API 37, arm64) y AVD ajenos que no se tocan. **No se instaló nada, no se instaló ningún APK en el teléfono y no se declara soporte Android.**

## 8. Resultado final de las pruebas

`npm test`: **285/285 en cinco ejecuciones seguidas** tras las correcciones (antes de la limpieza con reintentos, 2 de 8 ejecuciones completas habían fallado en la prueba del servidor). Cinco verdes no demuestran que el intermitente haya desaparecido: lo hacen menos probable y, si vuelve, el mensaje dice dónde.

Además: `smoke-delivery` 37/37 y los drills de escritorio de la sección 4 tras los últimos cambios de código del producto (`browsercheck`): sin repetir (el cambio no toca el escritorio; las pruebas de escenarios con Chrome real lo cubren).

## 9. Limitaciones

- Las causas de dos de los tres intermitentes se demostraron (limpieza bloqueada por el sistema; página a medio cargar); la del tercero (restos de procesos) sigue sin explicar.
- El nombre corto 8.3 depende de que el disco lo tenga activo; si no, Claude cae a «espera a Automata» (no se pierde seguridad, se pierde la comodidad de correr pruebas dentro de su turno).
- El drill de servidor local usa una app Node mínima, no una generada por los agentes; el camino ya estaba probado con agentes simulados (coordinador) y ahora con el escritorio real.
- Las pestañas de Chrome que abren los drills no las cierro (es tu navegador).
- Sigue sin soporte Windows (instalador) ni Android.

## 10. Decisiones que necesito

Las cuatro de `ANDROID_DELIVERY_PLAN.md` §8 (primer objetivo `WebView`, JDK, autorización para instalar/desinstalar un APK de prueba en el teléfono `R5CY61KW8LT` o un AVD nuevo, y dejar Gradle fuera), más: **¿publico P3 y P4 (push/merge de la rama)?** — no lo haré hasta que lo autorices.
