/** Catalogue français de la coque : clé = libellé source anglais, valeur = français. Une partie par domaine. */
import { FR_COMPONENTS } from "./fr-components.js";
import { FR_SCREENS } from "./fr-screens.js";
import { FR_SHELL } from "./fr-shell.js";

export const FR: Record<string, string> = { ...FR_SHELL, ...FR_COMPONENTS, ...FR_SCREENS };
