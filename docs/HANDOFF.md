# Traspaso — Automata, 26 oct 2026

## Estado

- **Rama:** `feature/director-observa-planes`, subida a GitHub. `main` no se tocó.
- **Commits:**
  - `1e81925`: director que observa, pregunta para correr la app, solo planes, cuentas y estados.
  - `2be6871`: modelos del director sacados de Codex y arreglo de Sol.
- **Pruebas:** `npm test` da 99 de 99, y `npm run smoke` pasa.
- **Pendiente de decidir:** abrir el pull request o juntar la rama con `main`.
- **App:** está instalada y abierta en `C:\proyectos\automata` con estos cambios.

## Qué cambió

1. **El director observa al codificador.**
   - `server/watch.mjs` anota en vivo lo que Claude lee, edita (con diffs) y ejecuta. El director lo recibe en su siguiente revisión, con la instrucción de no releer todo el proyecto.
   - Cada revisión guarda una copia en `round-NN/watch.txt`.
2. **"¿Correr la app?"**
   - La revisión del director trae un campo `run` (comando y dirección local).
   - Automata pregunta **Correr / Ahora no** una vez a mitad del trabajo y otra al terminar.
   - `server/apprun.mjs` corre la app, muestra su salida, detecta la dirección local y la detiene.
3. **Solo planes, nunca API.**
   - `planOnly` viene activado por defecto.
   - Claude y Codex se corren sin `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY` ni `CODEX_API_KEY`, así usan el plan Max y el de ChatGPT.
4. **Cuentas.**
   - Cada tarjeta muestra con qué cuenta está conectada (plan y correo, plan de ChatGPT, usuario de GitHub).
   - Tienen **Cambiar cuenta**, **Cerrar sesión** y el selector de modelo.
5. **Estados de los agentes.**
   - Cada panel muestra: Trabajando (con reloj), Observando, Verificando, Esperando, Pausando, En pausa, Completado, Necesita tu decisión o Error.
   - Debajo del nombre se ve la acción en curso, y mientras trabaja hay una barra animada arriba del panel.
6. **Modelos del director.**
   - La lista sale de `codex debug models` (`server/models.mjs`).
   - `gpt-6.1-sol` no existe para cuentas de ChatGPT: ahora es `gpt-6-sol`, y los ajustes viejos se corrigen solos.

Los detalles técnicos están en `docs/ARCHITECTURE.md`, en las secciones "El director observa…" y "Planes en vez de claves de API…".

## Decisiones del usuario

- **Pagar con el plan, no con la API.** Usar la API sería pagar doble.
- **La clave `ANTHROPIC_API_KEY` se queda en Windows**, porque la usan otras apps. No borrarla ni proponer borrarla.
- **La interfaz debe caber en una pantalla:** densa y sin scroll.

## Hallazgos

- **Cobro por uso antes del arreglo.** Las 3 tareas de Claude para la calculadora usaron la clave de API y costaron unos $0.70 USD. Ahora se verificó con una llamada real que sale `apiKeySource: none`.
- **La terminal ya usaba el plan:** `/status` muestra "Claude Max account".
- **Codex** usa la cuenta de ChatGPT (`codex login status`), y no hay claves de OpenAI en Windows.

## Cómo correr y probar

```powershell
cd C:\proyectos\automata
npm install
node node_modules/electron/install.js   # en esta PC npm install no baja Electron
.\Start-Automata.ps1                    # -Demo para probar sin créditos
npm test
npm run smoke                           # necesita Chrome
```

En esta PC no hay Python; los scripts auxiliares se hacen con Node.

## Pendientes y riesgos

- **Juntar con `main`:** abrir el pull request o hacer merge.
- **Probado solo con agentes simulados:** la bitácora del director y la pregunta para correr la app se probaron con agentes simulados y en el modo demo. Falta un trabajo completo con Claude y Codex reales.
- **Apps que piden escribir:** el que corre la app no deja escribirle (la entrada está cerrada). Una app de consola que pide datos no funciona ahí.
- **Android:** la vista de Android de los cambios nuevos no se probó en un teléfono.
- **`package-lock.json`:** está fuera de los commits a propósito. Salió del `npm install` local y el repo no lo tenía.
- **Proyecto aparte:** la calculadora que hizo Automata está en `C:\proyectos\calculadorta`, fuera de este repo.
