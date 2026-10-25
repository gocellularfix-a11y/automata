# Validación de Automata 0.1.1

Fecha: 2026-10-25. Primera implementación; no equivale a una certificación para trabajo desatendido.

| Comprobación | Resultado |
| --- | --- |
| `node --test test/*.test.mjs` | **16 aprobadas, 0 fallidas** |
| `node scripts/smoke.mjs` | **12 comprobaciones aprobadas** en Chrome de Windows |
| APK Android | Compilado y firma v2/v3 verificada |
| Instalación y ejecución en Samsung SM-S938B | **4 comprobaciones aprobadas**, conexión USB al coordinador |
| Paquete Windows portable | Generado en `dist/Automata-Windows` |
| Renderer nativo Electron (0.1.1) | **Aprobado**: EXE empaquetado, ventana visible, puente IPC, Node deshabilitado en la página y ciclo de demostración completo en modo de compatibilidad |
| Ventana Chrome lanzada directamente | **No validada** aquí: el proceso GPU falla; la misma interfaz funciona en Chrome bajo Playwright |
| Llamadas a Claude y Codex reales | **No ejecutadas** en esta sesión; no se consumieron créditos |
| Cuenta/modelos disponibles | No verificados contra los proveedores |
| Conexión Android por Wi-Fi/Internet | No probada; la prueba física usó USB y un reenvío ADB autenticado |
| Publicación en tiendas y firma de distribución | No realizada; el APK está firmado para desarrollo |

## Qué prueban los tests

- Aceptación basada en criterios originales y evidencia no vacía, con rechazo de hallazgos importantes pendientes.
- Rechazo de aprobaciones con verificaciones fallidas, y verificación de la ronda actual.
- Orden director → codificador → verificaciones → auditoría.
- Modelos/razonamiento conservados en el snapshot de cada ejecución.
- Adaptadores CLI ejecutados como procesos de prueba con stdin, JSONL, sesiones y resultados estructurados; auditor con sandbox de solo lectura.
- Argumentos transmitidos como datos, sin evaluar el prompt como PowerShell.
- Exclusión mutua, persistencia, pausa sin repetir tareas, límite de rondas y recuperación después de una interrupción.
- Instrucciones en cola que no omiten las verificaciones.
- Token y origen exigidos por la API.

## Prueba de interfaz

Chrome a 1480×1020 y 390×844: dos paneles de escritorio, pestañas móviles, cambio de modelos y esfuerzos, preferencias, ciclo completo de demostración, consulta al auditor, creación de un proyecto real sin iniciar AI, ausencia de desbordamiento horizontal y ausencia de solicitudes externas de la interfaz.

El ciclo de demostración genera `greet.mjs` y `greet.test.mjs` en una carpeta aislada y ejecuta `node --test` realmente. Las respuestas del director/codificador de este modo son deterministas y se identifican como demostración. Esto no verifica la calidad de las respuestas de los modelos reales.

## Prueba física de Android

El usuario conectó el Samsung por USB con ADB autorizado. Se instaló el APK, se abrió su WebView, se conectó al coordinador de la PC y se inició el ciclo desde la interfaz del teléfono. Se confirmó la verificación real aprobada, la vista del auditor, la ausencia de errores JavaScript y la ausencia de desbordamiento horizontal. Se dejó una sesión de demostración activa a petición del flujo de trabajo.

La prueba encontró y corrigió un defecto real de empaquetado de AAPT2 en Windows: separadores invertidos en rutas de recursos anidadas. Los recursos ahora se empaquetan planos. El JDK emitió una excepción de acceso al cerrar su ZIP en este entorno, aunque devolvió código 0 y generó clases; el DEX, la firma y la ejecución en el teléfono se comprobaron después.

## Siguiente validación necesaria

Completar una tarea pequeña con las dos CLI autenticadas. Revisar la salida real de permisos, modelos y uso antes de confiarle proyectos mayores. No se han utilizado archivos de Blueprint para simular una ejecución real.

## Corrección Windows 0.1.1

El paquete 0.1.0 no había pasado la prueba nativa; la interfaz de navegador no probaba el ejecutable. Se reprodujo el fallo y se identificó `launch-failed (49)`: Windows no podía crear el token restringido del renderer. Se implementó recuperación de compatibilidad para ese código, protocolo local para los recursos, diagnósticos persistentes y cierre fiable. La prueba nativa de 0.1.1 abre el EXE empaquetado en una ventana visible, comprueba que `window.require` no existe y completa el ciclo por IPC. Las capturas reales están en `artifacts/desktop-*/windows.png` y `artifacts/recovery-*/windows.png`.

Los reportes JSON y capturas están en `artifacts/` (excluido de Git). Las credenciales y los códigos de conexión tampoco se publican.
