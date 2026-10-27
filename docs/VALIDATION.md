# Validación de Automata 0.4.0

Fecha: 2026-10-26. Las pruebas con proveedores simulados no equivalen a validar inferencias reales.

| Comprobación | Resultado |
| --- | --- |
| `node --test test/*.test.mjs` | **41 aprobadas, 0 fallidas** |
| `node scripts/smoke.mjs` | **13 comprobaciones aprobadas** en Chrome de Windows |
| `node scripts/smoke-auth.mjs` | **14 comprobaciones aprobadas**, login de AI/GitHub con procesos simulados y navegador real |
| `node scripts/smoke-github.mjs` | **10 comprobaciones aprobadas**, GitHub simulado con clonación real de un repositorio Git local de prueba |
| `node scripts/smoke-chat.mjs` | **7 comprobaciones aprobadas**, estados del chat con proveedores simulados y navegador real |
| `scripts/smoke-console.ps1 -CompareWrapper` | **Reproducido y corregido**: 12 consolas visibles en 12 llamadas `--version` con el lanzador anterior; 0 en 12 llamadas con el ejecutable nativo |
| `node scripts/smoke-access.mjs` | **8 comprobaciones aprobadas**, CLI simuladas reciben permisos reales y crean archivos de prueba desde ambos roles |
| `node scripts/smoke-settings.mjs` | **12 comprobaciones aprobadas**, English/Español, persistencia, modelos, límites, respuestas de demo y configuración móvil |
| `node scripts/smoke-recovery.mjs` (0.4.0) | **Aprobado**: EXE actualizado, recuperación Windows, ciclo de demo completo, tareas directas y consulta por IPC |
| `node scripts/smoke-recovery.mjs --live` | **Aprobado**: EXE 0.3.0 abre la ventana de cuentas por IPC, incluye GitHub opcional, consulta las CLI instaladas y mantiene la recuperación de Windows |
| APK Android | Compilado y firma v2/v3 verificada |
| Instalación y ejecución en Samsung SM-S938B (0.4.0) | **8 comprobaciones aprobadas**: versión instalada, ciclo con checks reales, Settings, English/Español, controles de acceso y ausencia de errores o desbordamiento |
| Paquete Windows portable | Generado en `dist/Automata-Windows` |
| Renderer nativo Electron (0.1.1) | **Aprobado**: EXE empaquetado, ventana visible, puente IPC, Node deshabilitado en la página y ciclo de demostración completo en modo de compatibilidad |
| Ventana Chrome lanzada directamente | **No validada** aquí: el proceso GPU falla; la misma interfaz funciona en Chrome bajo Playwright |
| Inferencias con Claude y Codex reales | **No ejecutadas** en esta sesión; no se consumieron créditos |
| Cuenta/modelos disponibles | No verificados contra los proveedores |
| Conexión Android por Wi-Fi/Internet | No probada; la prueba física usó USB y un reenvío ADB autenticado |
| Publicación en tiendas y firma de distribución | No realizada; el APK está firmado para desarrollo |

## Qué prueban los tests

- Aceptación basada en criterios originales y evidencia no vacía, con rechazo de hallazgos importantes pendientes.
- Rechazo de aprobaciones con verificaciones fallidas, y verificación de la ronda actual.
- Orden director → codificador → verificaciones → auditoría.
- Modelos/razonamiento conservados en el snapshot de cada ejecución.
- Adaptadores CLI ejecutados como procesos de prueba con stdin, JSONL, sesiones y resultados estructurados; acceso completo en ambos roles y consulta explícita de solo lectura.
- Tareas sin iniciar el ciclo, cambios de permisos en la próxima operación y repetición de checks si el director modifica archivos al auditar.
- Idioma validado y transmitido en prompts sin traducir los criterios originales.
- Argumentos transmitidos como datos, sin evaluar el prompt como PowerShell.
- Exclusión mutua, persistencia, pausa sin repetir tareas, límite de rondas y recuperación después de una interrupción.
- Instrucciones en cola que no omiten las verificaciones.
- Token y origen exigidos por la API.

## Plan persistente y memoria conversacional (P2, 27 oct 2026)

`node --test test/*.test.mjs`: **145 aprobadas** (las 133 de P1 más 5 de `test/plan.test.mjs` y 7 de `test/plan-flow.test.mjs`). Ninguna prueba anterior cambió de expectativa.

Con agentes simulados: tareas con dependencias entre nuevas y existentes, historial e ids estables, plan que sobrevive a reabrir el archivo; transiciones, ciclos, referencias y evidencia validados sin dejar rastro; cobertura de criterios y reglas de `complete` y `continue` (descartar no cumple); bloque del plan dentro de 800 tokens y adaptado a Claude; sesiones de chat por agente, intercambios resumidos y aislamiento; ciclo completo con tareas asignadas en orden y confirmadas; decisión inválida devuelta al director tres veces; renovación de sesiones cada N rondas en puntos seguros con registro y medición de contexto; cierre con la revisión entregada sin aplicar el plan dos veces; conversación retomada, reiniciada y aislada; consultas, tareas directas, instrucciones y mensajes casuales; panel y API del plan.

`node scripts/smoke-plan.mjs`: **18 de 18** en Chrome. Los simulacros reales están en `P2_PERSISTENT_PLAN_REPORT.md`.

## Recuperación autónoma (P1, 27 oct 2026)

`node --test test/*.test.mjs`: **133 aprobadas** (las 115 anteriores más 18 de `test/recovery.test.mjs`). Dos pruebas anteriores cambiaron de expectativa a propósito: un mensaje del chat interrumpido se reencola una vez (antes quedaba interrumpido) y una aprobación con verificaciones fallidas se le devuelve al director hasta tres veces (antes era un error directo).

Con agentes y CLI simulados: clasificación de errores reales de ambas CLI (límite con hora en texto, `rate_limit_event`, error `usage_limit_exceeded` de Codex, turnos agotados, flujo cortado), espera con hora y reanudación desde la misma etapa, continuación de la ronda sin repetir la tarea, espera progresiva hasta `maxRetries`, tres correcciones del director, cierre y reapertura con resultado recuperado, Detener y Pausar durante la espera, cuentas no listas al reanudar, chat reencolado con respuestas conservadas, Git incierto, etapa `apply` sin repetir el commit, validación de ajustes y API, y marcado de recuerdos con archivos borrados.

`node scripts/smoke-waiting.mjs`: **12 de 12** en Chrome. Muestra el motivo, el agente y la hora; Continuar ahora, Pausar y Detener disponibles; traducción al inglés; pausa que cancela la cita; final sin repetir la ronda; teléfono sin desbordamiento.

El ciclo real con Claude y Codex, con una interrupción forzada, está documentado en `P1_RECOVERY_REPORT.md`. Los límites de cuota reales no se pudieron provocar: sus mensajes se tomaron de las cadenas de las CLI instaladas y la política tiene un respaldo genérico.

## Prueba de interfaz

Chrome a 1480×1020 y 390×844: dos paneles de escritorio, pestañas móviles, cambio de modelos y esfuerzos, preferencias, ciclo completo de demostración, consulta al auditor, creación de un proyecto real sin iniciar AI, ausencia de desbordamiento horizontal y ausencia de solicitudes externas de la interfaz.

El ciclo de demostración genera `greet.mjs` y `greet.test.mjs` en una carpeta aislada y ejecuta `node --test` realmente. Las respuestas del director/codificador de este modo son deterministas y se identifican como demostración. Esto no verifica la calidad de las respuestas de los modelos reales.

## Prueba física de Android

El usuario conectó el Samsung por USB con ADB autorizado. Se instaló el APK, se abrió su WebView, se conectó al coordinador de la PC y se inició el ciclo desde la interfaz del teléfono. Se confirmó la verificación real aprobada, la vista del auditor, la ausencia de errores JavaScript y la ausencia de desbordamiento horizontal. Se dejó una sesión de demostración activa a petición del flujo de trabajo.

La prueba encontró y corrigió un defecto real de empaquetado de AAPT2 en Windows: separadores invertidos en rutas de recursos anidadas. Los recursos ahora se empaquetan planos. El JDK emitió una excepción de acceso al cerrar su ZIP en este entorno, aunque devolvió código 0 y generó clases; el DEX, la firma y la ejecución en el teléfono se comprobaron después.

## Siguiente validación necesaria

Completar una tarea pequeña con las dos CLI autenticadas. Revisar la salida real de permisos, modelos y uso antes de confiarle proyectos mayores. No se han utilizado archivos de Blueprint para simular una ejecución real.

## Ventana de cuentas 0.2.0

Se probaron interpretación de estados CLI, restricciones de enlaces oficiales, reutilización de sesiones, exclusión de accesos duplicados, código de retorno de Claude, alternativa de dispositivo en Codex, cancelación, vencimiento, cierre de procesos y rechazo de accesos desde Android/orígenes ajenos. El API bloquea trabajos cuando faltan cuentas. No se serializan credenciales ni enlaces OAuth en sus respuestas de estado remotas.

La prueba de interfaz `smoke-auth.mjs` utiliza proveedores simulados identificados en el reporte, con Chrome real, para cubrir conexión por separado, regreso de código, cancelación, alternativa de dispositivo, habilitación de Continuar, ausencia de códigos en localStorage y vista móvil. No representa un acceso OAuth real a cuentas. El login real requiere que el usuario complete su acceso en el navegador oficial.

En la prueba nativa 0.2.0 con las CLI instaladas, Claude informó una sesión disponible. Codex devolvió `Could not find home directory` en el escritorio aislado de las herramientas, que se muestra como error de comprobación, sin inventar una conexión. Debe verificarse desde el escritorio normal de Windows del usuario. El flujo OAuth completo contra las cuentas reales no se ha ejecutado. Otra prueba ejecuta un subprocess Node real que representa una CLI, mantiene stdin abierto para el código de retorno y confirma su estado al terminar.

Las ventanas capturadas por las pruebas nativas pertenecen al escritorio aislado de las herramientas. No se ha verificado que un lanzamiento desde las herramientas aparezca delante del usuario; el EXE debe abrirse desde su escritorio de Windows.

## Proyectos locales y GitHub 0.3.0

La regresión del adaptador invoca un subprocess CLI de prueba que reproduce el error de directorio no confiable si falta `--skip-git-repo-check`; planificación y chat ahora terminan con el sandbox de solo lectura y sin crear `.git`. No se ha ejecutado una inferencia real de Codex para esta corrección.

Los tests de GitHub cubren URLs válidas e inyección, login opcional, conservación de carpetas ocupadas, coincidencia de `origin`, fallos sin credenciales en el mensaje, y proyectos Local sin autenticación de GitHub. Las pruebas de interfaz hacen una clonación Git real entre directorios de prueba a través de un adaptador GitHub simulado; comprueban crear desde un repo, rechazar sobrescritura, abrir una copia existente, rechazar remoto diferente, volver a Local sin inicializar Git, y ausencia de desbordamiento móvil.

No se ha completado un nuevo login de GitHub ni una clonación de red mediante la aplicación en este entorno. La conexión y los permisos de la cuenta deben probarse desde el escritorio normal del usuario.

## Consola y chat 0.3.1

La prueba Windows enumera únicamente ventanas visibles de clase `ConsoleWindowClass` en el escritorio de pruebas. No lee títulos ni contenido de otras aplicaciones. El ejecutable real Codex CLI 0.164.0 se consultó con `--version`, sin autenticación ni inferencia, usando el EXE GUI de Automata como proceso padre. La comparación reproduce la consola del lanzador npm y confirma su ausencia al ejecutar directamente el binario con la ventana oculta.

Las regresiones de chat cubren primer mensaje inmediato, segundo en cola, paso de cola a respuesta, respuesta parcial al consultar a ambos, errores en el panel, detener consultas y recuperación de una consulta interrumpida. Las pruebas de UI usan agentes simulados; no equivalen a una respuesta de un modelo real.

## Corrección Windows 0.1.1

El paquete 0.1.0 no había pasado la prueba nativa; la interfaz de navegador no probaba el ejecutable. Se reprodujo el fallo y se identificó `launch-failed (49)`: Windows no podía crear el token restringido del renderer. Se implementó recuperación de compatibilidad para ese código, protocolo local para los recursos, diagnósticos persistentes y cierre fiable. La prueba nativa de 0.1.1 abre el EXE empaquetado en una ventana visible, comprueba que `window.require` no existe y completa el ciclo por IPC. Las capturas reales están en `artifacts/desktop-*/windows.png` y `artifacts/recovery-*/windows.png`.

Los reportes JSON y capturas están en `artifacts/` (excluido de Git). Las credenciales y los códigos de conexión tampoco se publican.
