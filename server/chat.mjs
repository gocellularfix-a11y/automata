// Tells a casual message ("buen trabajo", "gracias", "hola") from a request for work. A casual one is
// answered by Automata itself: no agent runs, nothing changes in the project and no quota is spent.
// Conservative on purpose: anything that names an action, a file, code or a question goes to the agents.
const CASUAL = /^(?:(?:muchas |mil )?gracias|buen(?:a|o)?s? ?(?:trabajo|días|tardes|noches|chamba)|bien hecho|excelente|perfecto|genial|estupendo|increíble|impresionante|me gusta|ok|okay|vale|listo|hola|hey|hi|hello|thanks|thank you|good (?:job|work|morning|night)|nice|great|awesome|well done|👍|👏|🙌|❤️|sigue así|muy bien|de acuerdo|entendido|felicidades|wow)[\s!.,…]*(?:(?:compa|equipo|chicos|jóvenes|jovenes|team|amigos|claude|codex|a todos|señores)[\s!.,…]*)*$/i;
const ACTION = /\b(?:haz|hacer|crea|crear|agrega|agregar|añade|añadir|cambia|cambiar|arregla|arreglar|corrige|corregir|instala|instalar|implementa|implementar|mejora|mejorar|elimina|eliminar|borra|borrar|actualiza|actualizar|sube|subir|publica|publicar|compila|compilar|revisa|revisar|prueba|probar|ejecuta|ejecutar|quiero|necesito|puedes|podrías|debes|falta|faltan|error|bug|falla|archivo|función|pantalla|botón|boton|api|test|pruebas|código|codigo|commit|push|add|fix|build|run|make|create|update|remove|delete|install|deploy|change|implement|refactor|write|check|why|how|qué|que|cómo|como|por qué|cuándo|dónde)\b|[?¿\/\\.{}()\[\]=<>]/i;
export function isCasual(text) {
  const value = String(text ?? "").trim();
  if (!value || value.length > 80) return false;
  if (ACTION.test(value)) return false;
  return CASUAL.test(value);
}
export const casualAnswer = (language = "es") => language === "en"
  ? "Thanks! I did not send this to the agents because it does not ask for a change. Describe what you want built, fixed or checked and they will get to work."
  : "¡Gracias! No se lo pasé a los agentes porque el mensaje no pide ningún cambio. Describe qué quieres construir, corregir o revisar y se ponen a trabajar.";
