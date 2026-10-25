# Automata

**Claude construye. Codex dirige. Tú tienes el control.**

Aplicación para coordinar proyectos: el director convierte un objetivo en tareas, Claude implementa, se ejecutan verificaciones y Codex inspecciona la evidencia antes de generar el siguiente prompt.

Una interfaz compartida para Windows y Android: dos paneles en escritorio, pestañas en móvil y controles en la parte inferior.

## Incluido en 0.1

- Proyectos con carpeta, objetivo, criterios de aceptación, restricciones y comandos de verificación.
- Tareas pequeñas, medianas o largas.
- Selección independiente de modelos y razonamiento; identificadores personalizados.
- Ciclo automático director → codificador → verificaciones → auditoría.
- Pausa en un punto seguro, cancelación, continuación y límite de rondas/tiempo.
- Consultas a Claude, Codex o ambos; instrucciones al director entre operaciones.
- Historial, reportes y recuperación de sesiones interrumpidas.
- Conexión Android a la PC mediante código de acceso.
- Demostración aislada que no llama a proveedores ni consume créditos.

## Abrir en Windows

Con Node.js 22 o posterior y PowerShell:

```powershell
npm install
.\Start-Automata.ps1
```

Para probar un ciclo con un proyecto aislado:

```powershell
.\Start-Automata.ps1 -Demo
```

También se puede abrir `dist/Automata-Windows/Automata.exe` después de generar el paquete portable. No muevas solo el EXE: conserva su carpeta completa.

Si Electron no puede abrir su renderer en tu entorno, usa `Automata-Chrome.cmd` del paquete, o `.\Start-Automata.ps1 -Mode Browser`. Abre la misma interfaz en una ventana de aplicación de Chrome. Puedes agregar `-Demo` y `-Lan` al arranque PowerShell.

Para trabajar con AI reales, instala y autentica Claude Code y Codex CLI con sus herramientas oficiales. Automata reutiliza esas sesiones; no pide claves en la interfaz. Elegir un modelo no garantiza acceso en tu cuenta. Una sesión de Codex en Automata tiene su propio contexto; no hereda otra conversación de ChatGPT.

## Android

1. En Windows, abre Automata con `.\Start-Automata.ps1 -Lan`.
2. Pulsa el icono de teléfono para consultar la dirección y el código.
3. Instala el APK de desarrollo `dist/Automata-Android.apk`.
4. Pulsa «Conectar PC» en Android e introduce la dirección y el código.

La PC conserva los archivos, ejecuta los agentes y debe permanecer encendida. El acceso fuera de la red local requiere una conexión privada/HTTPS; Automata no publica tu PC en Internet.

## Verificar y compilar

```powershell
npm test
npm run smoke
node scripts/smoke-desktop.mjs
npm run build:windows
npm run build:android
```

Para actualizar un paquete Windows ya generado: `node scripts/build-windows.mjs --refresh`.

Las pruebas de interfaz requieren Chrome, o `CHROME_PATH`. La prueba nativa requiere un entorno Windows que permita los subprocesos de Electron. Las compilaciones Android usan JDK 17, Android SDK Platform 36 y Build Tools, sin Gradle ni descargas durante la compilación:

```powershell
.\scripts\build-android.ps1 -Sdk 'C:\ruta\Android\Sdk' -JavaHome 'C:\ruta\jdk-17'
```

El APK usa una firma de desarrollo local; no es una publicación en Google Play.

## Datos y límites

El escritorio guarda proyectos y reportes en su carpeta de datos de usuario. El servidor usa `.automata/`. Estos archivos, los resultados de pruebas y los paquetes generados están excluidos de Git. No se incluyen proyectos de Blueprint.

El auditor revisa en modo de solo lectura. El codificador conserva los permisos de Claude Code; Automata no los desactiva. Los comandos de verificación son los que defines al crear el proyecto. Commit, push y despliegue están fuera de las tareas automáticas.

La aprobación necesita evidencia para todos los criterios y verificaciones aprobadas en la ronda actual. Sigue siendo una revisión de AI: conserva las comprobaciones apropiadas para tu proyecto.

Arquitectura y fuentes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Estado de validación: [docs/VALIDATION.md](docs/VALIDATION.md).
