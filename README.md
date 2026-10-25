# Automata

Aplicacion de terminal en PowerShell que coordina el desarrollo con Claude Code y la inspeccion con Codex CLI.

## Primera version

1. Definir la carpeta del proyecto, objetivo, alcance y criterios de aceptacion.
2. Claude implementa una tarea y entrega su reporte.
3. Ejecutar las verificaciones definidas para el proyecto.
4. Codex inspecciona el reporte, los cambios y la evidencia.
5. Generar el siguiente prompt y pasarlo a Claude, o terminar el ciclo.

Cada ronda conservara sus prompts, reportes y resultados. El coordinador tendra un limite de rondas y permitira iniciar, pausar y continuar. Solo un agente trabajara sobre el proyecto a la vez.

## Estado

Estructura inicial del proyecto. El coordinador todavia no esta implementado.

## Requisitos previstos

- PowerShell.
- Git.
- Claude Code y Codex CLI instalados y autenticados.

Las credenciales, configuraciones personales y resultados de ejecuciones deben mantenerse fuera del repositorio. No se incluyen proyectos supervisados ni archivos de Blueprint.
