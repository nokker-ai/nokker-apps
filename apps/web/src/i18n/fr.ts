/** Catalogue français de la coque : clé = libellé source anglais, valeur = français. Une partie par domaine. */
import { FR_COMPONENTS } from "./fr-components.js";
import { FR_SCREENS } from "./fr-screens.js";
import { FR_SHELL } from "./fr-shell.js";
import { FR_LEARNING } from "./fr-learning.js";
import { FR_PAYMENTS } from "./fr-payments.js";
import { FR_FOLDER } from "./fr-folder.js";
import { FR_KNOCK } from "./fr-knock.js";
import { FR_SHOWME } from "./fr-showme.js";
import { FR_GUIDE } from "./fr-guide.js";
import { FR_BROWSER } from "./fr-browser.js";
import { FR_FOYER } from "./fr-foyer.js";
import { FR_VOICE } from "./fr-voice.js";
import { FR_WALLSCREEN } from "./fr-wallscreen.js";
import { FR_ACCORD } from "./fr-accord.js";

export const FR: Record<string, string> = { ...FR_SHELL, ...FR_COMPONENTS, ...FR_SCREENS, ...FR_LEARNING, ...FR_PAYMENTS, ...FR_FOLDER, ...FR_KNOCK, ...FR_SHOWME, ...FR_GUIDE, ...FR_BROWSER, ...FR_FOYER, ...FR_VOICE, ...FR_WALLSCREEN, ...FR_ACCORD };
