# P3 · De una idea a un proyecto: reporte

Fecha: 27 oct 2026 · Rama: `feature/p3-idea-to-project` (a partir de `785d41f`, la P2 publicada) · Sin push ni merge.

## Veredicto

P3 está implementado y probado. Con Claude y Codex reales, la frase «Quiero una aplicación para administrar el inventario de mi tienda», escrita en la interfaz, terminó en **11 minutos** en una aplicación web local entregada en su propia carpeta: plan de 10 tareas hecho, 9 criterios con evidencia, 14 de 14 pruebas del proyecto en verde cuando las corrí yo, y la aplicación funcionando como dice su README. La persona intervino **dos veces**: escribir la idea y pulsar «Crear y empezar».

Ese ciclo real dejó tres hallazgos. Dos están corregidos pero **sin volver a validar con agentes reales**: el director no decidió ningún commit (el trabajo quedó sin guardar en Git) y 2 de 3 propuestas se rechazaron solo por citar criterios abreviados. El tercero es de consumo: el contexto del director creció hasta 726 000 tokens por revisión con la renovación cada 8 rondas. Un segundo ciclo real para validar las correcciones se detuvo por falta de memoria del sistema mientras se preparaba la propuesta; no se creó nada y no lo relancé.

| Commit | Contenido |
|---|---|
| `8740f66` | Reglas de carpetas, propuesta del director, aprobación única, archivos orientativos para Claude, confirmación de tareas directas e historial de reordenamiento |
| `adc0390` | Interfaz «Nueva idea», línea «Construyendo…», botones Confirmar/Revisar de nuevo; pruebas de interfaz |
| `59f5574` | Prueba de P1 que comparaba tiempos de reloj, ahora determinista |
| `feeeaf5` | Documentación y script del ciclo real |
| `84922d9` | Correcciones del ciclo real: commits locales y criterios abreviados; carrera en una prueba de P1 |
| *(este commit)* | Este reporte |

---

## 1. Qué se construyó

| Requisito | Dónde | Cómo |
|---|---|---|
| **1. Entrada sencilla** | Botón «Nueva idea» y diálogo `#ideaDialog` | Una caja de texto: «¿Qué quieres crear?». «Proyecto manual» conserva el formulario anterior. |
| **2. Propuesta** | `server/prompts.mjs` (`proposalPrompt`), `config.mjs` (`PROPOSAL_SCHEMA`, `validateProposal`), `coordinator.mjs` (`propose`, `draftProposal`) | El director, en solo lectura y en una carpeta vacía de borrador, devuelve nombre, resumen, objetivo, funciones, criterios comprobables, comandos de verificación, plataforma, plan con dependencias, riesgos y preguntas. Se exige: al menos 3 criterios, una verificación, un plan de 3 tareas o más que cubra cada criterio, dependencias válidas. Lo inválido vuelve al director hasta 3 veces. La persona puede ajustar (la propuesta anterior viaja con el pedido) o descartar. |
| **3. Una sola aprobación** | `acceptProposal`, `POST /api/ideas` | «Crear y empezar» crea la carpeta con Git y un commit inicial (`github.createNew`, sin remoto), registra el proyecto, siembra el plan aprobado, guarda en la memoria la plataforma y las limitaciones aceptadas, e inicia el trabajo. Push y merge siguen pidiendo aprobación aparte. |
| **4. Seguridad** | `server/safety.mjs`; `validateProject(…, { safety })` al registrar y al iniciar | Se rechazan la raíz del disco, Automata y cualquier carpeta que la contenga (así se rechaza `C:\proyectos`), los datos de Automata, Windows, Archivos de programa, `AppData`, `ProgramData` y carpetas privadas (`.ssh`, `.claude`, `.codex`…), el usuario entero y sus carpetas principales (una subcarpeta de Documentos sí vale), la carpeta de proyectos misma y carpetas con otros repositorios Git (hasta tres niveles, sin contar `node_modules`). Los proyectos registrados antes de estas reglas también se rechazan al iniciar. Las restricciones de cada proyecto creado desde una idea prohíben publicar, comprar, crear cuentas, push y merge, y afirmar calidad comercial. Los permisos de Claude y Codex no cambiaron. |
| **5. Verificación** | `validateProposal`, `prompts.mjs` (`brief`), `start` | Sin al menos un comando de verificación no hay propuesta válida. Un proyecto manual sin verificaciones arranca con un aviso, y el director recibe la instrucción de que la primera tarea cree pruebas. `complete` sigue exigiendo evidencia por criterio y el plan cerrado (P2). Riesgos y restricciones recuerdan que pruebas aprobadas no son calidad comercial. |
| **6. Experiencia** | `public/` | La propuesta se lee sin jerga: qué hará, cómo sabremos que funciona, dónde se usará, pasos con «después de…», qué tener en cuenta, dónde se guardará; los comandos quedan en «Detalles técnicos», cerrado. Mientras trabaja, la línea de estado dice «Construyendo: «tarea» · faltan N tareas de M». Los mensajes casuales no inician propuestas ni trabajo. |
| **7. Eficiencia** | `REVIEW_SCHEMA.files`, `coderPrompt`, `usageLog` | El director lista en cada revisión hasta 12 archivos relativos para la tarea; Claude los recibe como «ARCHIVOS RELEVANTES PARA ESTA TAREA». Rutas absolutas o con `..` se descartan. `usageLog` registra cuántos recibió cada llamada y el consumo por llamada. |
| **8. Pendientes de P2** | Panel Plan, `plan.reorder` | Una tarea directa «por confirmar» se confirma o se devuelve desde el panel. Reordenar deja una fila de historial por tarea movida. |

---

## 2. Pruebas

**Automáticas: 154 de 154** (las 145 de P2 más 9 nuevas en `test/ideas.test.mjs`). La suite completa pasó tres veces seguidas. Cambió una expectativa a propósito: el historial del plan incluye ahora la fila de reordenamiento. Dos pruebas de P1 dependían de tiempos y fallaban a veces bajo carga; ahora comparan esperas planificadas o usan una espera larga.

Pruebas nuevas:
- reglas de carpetas: raíz, Automata y su carpeta padre, datos, sistema, usuario, Documentos, `.ssh`, carpeta de proyectos, repositorios anidados, `node_modules`, `.git` propio y subcarpetas válidas;
- rechazo al registrar y al iniciar, incluido un proyecto registrado antes de las reglas;
- validación de la propuesta y vínculo de criterios citados abreviados;
- flujo completo: corrección, ajuste, aceptación, plan sembrado con dependencias, archivos para Claude y memoria;
- propuesta fallida por límite o por cierre;
- confirmación y devolución de tareas directas, y reordenamiento con historial;
- API de ideas con carpeta y Git reales, y rechazo en demostración;
- CLI simulada en la fase `define`, en solo lectura;
- regla de commit con cambios sin confirmar.

**Interfaz en Chrome:**

| Prueba | Resultado |
|---|---|
| `smoke-ideas` (nueva) | **27 de 27**: idea casual rechazada, propuesta legible, ajuste, una aprobación, carpeta con Git, «Construyendo…», plan 5/5, carpeta peligrosa rechazada con explicación, teléfono sin desbordamiento |
| `smoke-plan`, `smoke-waiting`, `smoke-memory`, `smoke` | Aprobadas |
| `smoke-chat`, `smoke-access`, `smoke-github`, `smoke-settings` | Aprobadas |

Las pruebas antiguas creaban sus proyectos dentro de `artifacts/`, que está dentro de Automata y ahora se rechaza: se movieron a carpetas temporales. `smoke-settings` estaba rota desde el rediseño anterior a P1 (contaba 9 campos y buscaba un título que ya no existe) y se actualizó.

---

## 3. Evidencia con agentes reales

Segunda instancia de Automata con su propia carpeta de datos (`scripts/real-idea.mjs`, artefactos en `artifacts/real-idea-2026-10-27T21-42-23-396Z/`), manejada desde Chrome. Cuentas reales conectadas, Claude `claude-sonnet-5-5` (razonamiento medio), Codex `gpt-6-luna`, **acceso limitado**, solo planes, Git en modo `ask-push`, carpeta de proyectos `C:\Users\cellh\Automata Projects`.

**Propuesta** (63 s, 3 llamadas): «Inventario de tienda», página web local servida por Node.js.
- 7 funciones: registrar, ver, buscar, editar, eliminar con confirmación, avisar existencias bajas, guardar en la PC.
- 9 criterios observables, por ejemplo: «Al guardar un producto con cantidad menor que su mínimo, la lista lo identifica como existencias bajas; si la cantidad alcanza o supera el mínimo, deja de marcarlo así».
- Verificaciones: `node --test tests` y `node --check server.js`.
- 10 tareas con dependencias, por ejemplo «Comprobar persistencia y eliminación» después de las tareas 2 y 5.
- 4 riesgos en lenguaje sencillo, incluido «Las pruebas aprobadas comprueban los criterios indicados, pero no garantizan calidad comercial».
- Las dos primeras versiones se rechazaron por citar criterios abreviados; la tercera fue válida.

**Construcción** (10,8 min, 14 rondas, sin intervención):

| Ronda | Tarea en curso |
|---|---|
| 1–4 | Preparar la estructura y las pruebas (con correcciones directas) |
| 5–14 | Almacenamiento; validación; pantalla y búsqueda; edición y eliminación; alertas; persistencia; documentación (2 rondas); arranque documentado; pruebas de eliminación |
| 14 | `complete`: 10 de 10 tareas hechas, 9 de 9 criterios con evidencia, 0 hallazgos |

Una revisión de la ronda 8 no indicó la tarea asignada; Automata la devolvió y el director la corrigió al segundo intento. Hubo dos renovaciones de sesión (ronda 8 del director, ronda 9 de Claude).

**Verificación independiente, hecha por mí después:**
- Las dos verificaciones del proyecto: `node --test tests` con 14 de 14, y `node --check server.js` aprobado.
- Arranqué `node server.js` como dice el README, con los datos en una carpeta temporal. La página respondió 200 con el título correcto.
- Por la API: un alta válida quedó marcada con existencias bajas; un código duplicado, un precio negativo y un nombre vacío se rechazaron con mensajes en español; editar la cantidad quitó la marca; eliminar funcionó; `/../server.js` y `/%2e%2e/server.js` devolvieron 404.
- Los otros 6 proyectos de `Automata Projects` quedaron con el mismo `HEAD` y el mismo estado de Git. Automata cambió solo por un commit de documentación mío (`feeeaf5`) hecho durante el ciclo; su árbol quedó limpio.
- **El proyecto no tiene commits del trabajo:** solo existe «chore: inicio del proyecto», y todo lo construido está sin confirmar. El director decidió `commit=false` en las 14 revisiones (ver fallas).
- Ninguna operación de push, merge ni publicación se ejecutó ni se propuso.

**Segundo ciclo real** («Quiero llevar el control de los gastos de mi casa cada mes»), para validar las correcciones: Claude Code lo detuvo a los pocos segundos por falta de memoria del sistema mientras Codex preparaba la propuesta. No se creó ningún proyecto, no quedó ningún proceso de esa instancia y no lo relancé.

---

## 4. Consumo de tokens

Contexto leído por llamada (entrada más caché), según cada CLI:

| | P2 · agenda (renovación cada 2) | P3 · inventario (renovación cada 8) |
|---|---|---|
| Llamadas de Claude | 10 | 14 |
| Contexto promedio de Claude | 163 289 | 252 222 (95 % desde caché) |
| Llamadas de Codex | 12 | 15 |
| Contexto promedio de Codex | 80 573 | 312 419 (87 % desde caché) |
| Máximo de Codex | 138 473 | **726 257** |
| Propuesta (3 llamadas) | — | 136 849 |

**Lo que muestran los datos:**
- **El contexto del director crece unos 110 000 tokens por ronda** mientras retoma la sesión: de 104 000 en la ronda 2 a 645 000 en la 7. Tras la renovación de la ronda 8 baja a 47 000 y vuelve a subir hasta 726 000 en la 14. Con 8 rondas por sesión, la renovación casi no ayuda en trabajos de unas 14 rondas. En P2, con renovación cada 2, el máximo fue 138 000. La mayor parte se lee desde caché, pero igual cuenta para el límite del plan.
- **Claude** depende más de lo que lee que de la conversación. Su contexto subió con el tamaño de la aplicación web (HTML, JS, CSS y pruebas) y con la sesión retomada.
- **Archivos orientativos:** el director nombró de 1 a 5 archivos en cada ronda, todos dentro del proyecto. Con un solo proyecto no se puede atribuir un ahorro a esta medida: el proyecto es más grande que el de P2 y no hubo una corrida de control sin la lista. Queda como orientación segura, no como ahorro demostrado.
- **Propuesta:** dos de las tres llamadas se perdieron por citar criterios abreviados (unos 76 000 tokens). La corrección de `84922d9` las habría aceptado.

---

## 5. Problemas pendientes

1. **Commits locales sin validar con agentes reales.** El director no guardó ningún hito. Se aclararon las restricciones («los commits locales sí: el director decide uno en cada hito verificado») y la regla de Git ahora pide `commit=true` cuando hay cambios sin confirmar y la ronda cierra algo verificable o se completa. Está probado en el prompt, no con Codex. Hasta validarlo, un proyecto puede terminar sin ninguna versión guardada en Git.
2. **Vínculo de criterios abreviados sin validar con agentes reales.** Solo está probado con datos simulados.
3. **Consumo del director con `sessionRefreshRounds = 8`.** Recomiendo renovar la sesión del director con más frecuencia que la de Claude, por ejemplo cada 3 rondas, o bajar el valor por defecto. El 8 fue tu decisión en P2, así que no lo cambié.
4. **Mientras se prepara una propuesta, el equipo está ocupado:** no se puede proponer mientras otro trabajo corre, y viceversa. Es la regla de una operación de agente a la vez; está documentada y el mensaje lo explica.
5. **Verificaciones débiles.** El director propuso `node --check server.js`, que solo comprueba la sintaxis. La validación exige al menos un comando, no su calidad. El criterio de arranque se cumplió por inspección del director y por mi prueba manual, no por una verificación automática.
6. **Datos de la aplicación en la carpeta del proyecto.** El inventario se guarda en `data/`, que la aplicación ignora en Git. Es razonable, pero la persona debe saber que borrar la carpeta borra los datos; el README lo dice.
7. **La experiencia no la probó una persona real sin conocimientos técnicos.** Se probó con Chrome automatizado y con textos revisados por mí; falta observar a alguien usándola. Android no se probó con el diálogo nuevo.
8. **El segundo ciclo real no se completó** (falta de memoria del sistema). Las correcciones 1 y 2 necesitan ese ciclo.
9. `package-lock.json` sigue fuera de Git, como en las fases anteriores.

## 6. Recomendación para la siguiente fase

Antes de seguir con funciones nuevas:
1. Repetir un ciclo real corto desde una idea, con la memoria del sistema libre, para validar los commits locales y la propuesta al primer intento.
2. Decidir la renovación de sesiones del director: propongo 3 rondas para Codex y 8 para Claude, configurable por rol.

Después, la fase 4 del roadmap (entorno y entrega):
- comprobar el entorno antes de empezar (Node, JDK y Android SDK según la plataforma propuesta);
- una etapa de entrega obligatoria: cómo abrir la aplicación con un clic, la guía para la persona y un resumen «qué hace / qué no hace»;
- verificaciones de arranque reales, por ejemplo un script que inicie el servidor y compruebe la página, en lugar de `node --check`.
