/**
 * Texts of the Guide, by catalogue id (core `nokker/guide/catalog.py`, docs/GUIDE.md). The core sends codes only; the
 * web words them here, in French and English (like « who does what »). `GUIDE_IDS` is the catalogue's list of ids,
 * copied: a test checks that every id has a French AND an English text, so a feature added to the core without its
 * words is caught here. Screen file of the i18n test: French is allowed in this dictionary.
 */

export interface GuideText {
  name: string;
  /** What it is for, one sentence. */
  purpose: string;
  /** How to turn it on or use it, one sentence. */
  how: string;
}

export const GUIDE_TEXTS: Record<string, { fr: GuideText; en: GuideText }> = {
  web_search: {
    fr: { name: "Recherche web", purpose: "Chercher sur le web et lire des pages, avec les sources.", how: "Rien à activer : demande-le dans le fil." },
    en: { name: "Web search", purpose: "Search the web and read pages, with sources.", how: "Nothing to turn on: ask in the thread." },
  },
  images: {
    fr: { name: "Images jointes", purpose: "Joindre une photo ou une capture et la faire lire.", how: "Bouton trombone du fil, ou glisser l'image." },
    en: { name: "Attached images", purpose: "Attach a photo or a screenshot and have it read.", how: "Paperclip button of the thread, or drop the image." },
  },
  text_attachments: {
    fr: { name: "Documents joints", purpose: "Joindre un texte, un PDF ou un tableau à lire.", how: "Bouton trombone du fil." },
    en: { name: "Attached documents", purpose: "Attach a text, a PDF or a spreadsheet to read.", how: "Paperclip button of the thread." },
  },
  previews: {
    fr: { name: "Aperçus de liens", purpose: "Voir l'aperçu d'une page citée dans une réponse.", how: "Rien à activer : les liens des réponses ont leur aperçu." },
    en: { name: "Link previews", purpose: "See a preview of a page quoted in a reply.", how: "Nothing to turn on: links in replies have their preview." },
  },
  steer: {
    fr: { name: "Corriger en cours de route", purpose: "Ajouter une consigne pendant que l'agent travaille, sans l'arrêter.", how: "Écris dans le fil pendant que l'agent travaille." },
    en: { name: "Steer a running turn", purpose: "Add an instruction while the agent works, without stopping it.", how: "Write in the thread while the agent works." },
  },
  bubbles: {
    fr: { name: "Bulles", purpose: "Garder à l'écran des objets vivants : liste, tableau, suivi.", how: "Demande-le dans le fil ; les bulles se déplacent d'un fil à l'autre." },
    en: { name: "Bubbles", purpose: "Keep living objects on screen: a list, a board, a tracker.", how: "Ask in the thread; bubbles move from one thread to another." },
  },
  show_me: {
    fr: { name: "Montre-moi", purpose: "L'agent montre où cliquer au lieu de le faire à ta place.", how: "Demande « montre-moi » dans le fil." },
    en: { name: "Show me", purpose: "The agent shows where to click instead of doing it for you.", how: "Ask “show me” in the thread." },
  },
  who_does_what: {
    fr: { name: "Qui fait quoi", purpose: "Voir d'un coup d'œil ce que font tes agents et ce qui attend.", how: "Panneau « Qui fait quoi » à côté du fil." },
    en: { name: "Who does what", purpose: "See at a glance what your agents are doing and what is waiting.", how: "“Who does what” panel next to the thread." },
  },
  approvals: {
    fr: { name: "Cartes d'approbation", purpose: "Rien d'important ne part sans ton accord : envoi, achat, suppression.", how: "Rien à activer : la carte apparaît dans le fil quand il faut décider." },
    en: { name: "Approval cards", purpose: "Nothing important leaves without your say-so: sending, buying, deleting.", how: "Nothing to turn on: the card appears in the thread when a decision is needed." },
  },
  telegram: {
    fr: { name: "Telegram", purpose: "Recevoir les cartes et répondre depuis Telegram.", how: "Mon compte → relier Telegram (code d'appairage)." },
    en: { name: "Telegram", purpose: "Receive the cards and answer from Telegram.", how: "My account, link Telegram (pairing code)." },
  },
  auto_review: {
    fr: { name: "Relecture automatique", purpose: "Les cartes sans risque sont relues et validées seules, selon tes règles.", how: "Réglé par l'installation ; tes règles se voient dans Apprentissage." },
    en: { name: "Automatic review", purpose: "Low-risk cards are reviewed and approved on their own, following your rules.", how: "Set by the installation; your rules show in Learning." },
  },
  approval_suggestions: {
    fr: { name: "Règles suggérées", purpose: "Après des approbations répétées, proposer une règle pour ne plus redemander.", how: "Écran Apprentissage → règles suggérées." },
    en: { name: "Suggested rules", purpose: "After repeated approvals, suggest a rule so it stops asking.", how: "Learning screen, suggested rules." },
  },
  subagents: {
    fr: { name: "Sous-agents", purpose: "Confier une partie du travail à un sous-agent en parallèle.", how: "Demande-le dans le fil." },
    en: { name: "Sub-agents", purpose: "Hand part of the work to a sub-agent in parallel.", how: "Ask in the thread." },
  },
  delegate_fork: {
    fr: { name: "Sous-agent qui reprend le fil", purpose: "Un sous-agent qui part avec tout le contexte du fil.", how: "Demande-le dans le fil." },
    en: { name: "Forked sub-agent", purpose: "A sub-agent that starts with the whole context of the thread.", how: "Ask in the thread." },
  },
  crew: {
    fr: { name: "Crew (agents récurrents)", purpose: "Des agents qui travaillent seuls à heure fixe : veille, brief du matin.", how: "Écran Crew → nouvel agent, ou demande-le dans le fil." },
    en: { name: "Crew (recurring agents)", purpose: "Agents that work alone at a set time: monitoring, morning brief.", how: "Crew screen, new agent, or ask in the thread." },
  },
  goals: {
    fr: { name: "Objectifs", purpose: "Fixer un but : l'agent continue jusqu'à ce qu'un correcteur le juge atteint.", how: "Tape /goal suivi du but dans le fil." },
    en: { name: "Goals", purpose: "Set a goal: the agent keeps going until a checker judges it reached.", how: "Type /goal followed by the goal in the thread." },
  },
  rubric: {
    fr: { name: "Critères de réussite", purpose: "Donner des critères vérifiables ; une réponse est notée et reprise si elle ne les remplit pas.", how: "Donne les critères dans le fil, puis /goal valide." },
    en: { name: "Success criteria", purpose: "Give checkable criteria; an answer is graded and redone if it falls short.", how: "Give the criteria in the thread, then /goal checks." },
  },
  advisor: {
    fr: { name: "Conseiller", purpose: "Demander l'avis d'un modèle plus fort sur un point difficile.", how: "Réglé par l'installation ; demande-le dans le fil." },
    en: { name: "Advisor", purpose: "Ask a stronger model for its view on a hard point.", how: "Set by the installation; ask in the thread." },
  },
  plan: {
    fr: { name: "Plan", purpose: "Découper un projet en lots et tâches suivis.", how: "Écran Plan." },
    en: { name: "Plan", purpose: "Break a project into tracked batches and tasks.", how: "Plan screen." },
  },
  incidents: {
    fr: { name: "Incidents", purpose: "Suivre les alertes et incidents de tes services.", how: "Écran Incidents." },
    en: { name: "Incidents", purpose: "Follow the alerts and incidents of your services.", how: "Incidents screen." },
  },
  code: {
    fr: { name: "Sessions de code", purpose: "Travailler sur un dépôt de code dans un bac à sable.", how: "Écran Code → nouvelle session." },
    en: { name: "Code sessions", purpose: "Work on a code repository in a sandbox.", how: "Code screen, new session." },
  },
  execute_code: {
    fr: { name: "Exécuter du code", purpose: "Faire calculer ou transformer des données par un script.", how: "Demande-le dans le fil." },
    en: { name: "Run code", purpose: "Have a script compute or transform data.", how: "Ask in the thread." },
  },
  packs: {
    fr: { name: "Packs d'agents", purpose: "Ajouter des agents et compétences tout prêts.", how: "Menu du compte → Packs." },
    en: { name: "Agent packs", purpose: "Add ready-made agents and skills.", how: "Account menu, Packs." },
  },
  long_memory: {
    fr: { name: "Mémoire", purpose: "Se souvenir de toi d'une conversation à l'autre.", how: "Rien à activer : dis-le simplement." },
    en: { name: "Memory", purpose: "Remember you from one conversation to the next.", how: "Nothing to turn on: just say it." },
  },
  learning: {
    fr: { name: "Apprentissage", purpose: "Voir et corriger ce que l'agent a appris de toi.", how: "Écran Apprentissage." },
    en: { name: "Learning", purpose: "See and correct what the agent has learned about you.", how: "Learning screen." },
  },
  memory_pending: {
    fr: { name: "Notes à valider", purpose: "Valider une note avant qu'elle entre en mémoire.", how: "Écran Apprentissage → en attente." },
    en: { name: "Notes to review", purpose: "Approve a note before it enters memory.", how: "Learning screen, pending." },
  },
  memory_consolidation: {
    fr: { name: "Rangement de la mémoire", purpose: "Chaque nuit, la mémoire est rangée : doublons fusionnés, notes périmées signalées.", how: "Rien à activer." },
    en: { name: "Memory tidy-up", purpose: "Every night memory is tidied: duplicates merged, stale notes flagged.", how: "Nothing to turn on." },
  },
  connectors: {
    fr: { name: "Mail et agenda", purpose: "Lire, trier et préparer tes mails ; gérer ton agenda.", how: "Menu du compte → Connecteurs." },
    en: { name: "Mail and calendar", purpose: "Read, sort and prepare your mail; manage your calendar.", how: "Account menu, Connectors." },
  },
  team: {
    fr: { name: "Équipe", purpose: "Inviter des collègues et partager des fils et des agents.", how: "Menu du compte → Équipe." },
    en: { name: "Team", purpose: "Invite colleagues and share threads and agents.", how: "Account menu, Team." },
  },
  sso: {
    fr: { name: "Connexion d'entreprise", purpose: "Se connecter avec le compte de l'entreprise.", how: "Menu du compte → Équipe → connexion." },
    en: { name: "Company sign-in", purpose: "Sign in with your company account.", how: "Account menu, Team, sign-in." },
  },
  household: {
    fr: { name: "Foyer", purpose: "Partager l'assistant avec ta famille, chacun son espace.", how: "Menu du compte → Foyer → inviter." },
    en: { name: "Household", purpose: "Share the assistant with your family, each with their own space.", how: "Account menu, Household, invite." },
  },
  household_minors: {
    fr: { name: "Profils enfants", purpose: "Un profil encadré pour un enfant, avec liste blanche.", how: "Foyer → ajouter un enfant." },
    en: { name: "Child profiles", purpose: "A supervised profile for a child, with an allow-list.", how: "Household, add a child." },
  },
  household_paper: {
    fr: { name: "Papiers du foyer", purpose: "Classer factures et courriers, préparer les paiements et la déclaration.", how: "Joins le document dans le fil." },
    en: { name: "Household paperwork", purpose: "File bills and letters, prepare payments and the tax return.", how: "Attach the document in the thread." },
  },
  family_calendar: {
    fr: { name: "Calendrier familial", purpose: "Lire un programme (photo, PDF) et proposer les dates dans l'agenda.", how: "Joins la photo ou le PDF dans le fil." },
    en: { name: "Family calendar", purpose: "Read a schedule (photo, PDF) and suggest the dates for the calendar.", how: "Attach the photo or the PDF in the thread." },
  },
  payments: {
    fr: { name: "Paiements encadrés", purpose: "Laisser l'agent acheter dans un budget, chaque achat confirmé.", how: "Mon compte → paiements (budget et clé d'accès)." },
    en: { name: "Guarded payments", purpose: "Let the agent buy within a budget, each purchase confirmed.", how: "My account, payments (budget and access key)." },
  },
  house_room: {
    fr: { name: "Salle Maison", purpose: "Un salon commun où les agents du foyer répondent à tous.", how: "Écran Maison." },
    en: { name: "House room", purpose: "A shared lounge where the household agents answer everyone.", how: "Home screen." },
  },
  billing: {
    fr: { name: "Abonnement", purpose: "Voir ton offre, ta consommation et changer de formule.", how: "Mon compte → abonnement." },
    en: { name: "Subscription", purpose: "See your plan and your usage, and change plan.", how: "My account, subscription." },
  },
  slack: {
    fr: { name: "Slack", purpose: "Parler à l'agent depuis Slack.", how: "Mon compte → relier Slack." },
    en: { name: "Slack", purpose: "Talk to the agent from Slack.", how: "My account, link Slack." },
  },
  whatsapp: {
    fr: { name: "WhatsApp", purpose: "Parler à l'agent depuis WhatsApp.", how: "Mon compte → relier WhatsApp." },
    en: { name: "WhatsApp", purpose: "Talk to the agent from WhatsApp.", how: "My account, link WhatsApp." },
  },
  voice: {
    fr: { name: "Voix", purpose: "Faire lire une réponse à voix haute.", how: "Bouton haut-parleur d'une réponse." },
    en: { name: "Voice", purpose: "Have a reply read aloud.", how: "Speaker button on a reply." },
  },
  speak_lexicon: {
    fr: { name: "Prononciation", purpose: "Apprendre à la voix comment prononcer les noms du foyer.", how: "Foyer → prononciation." },
    en: { name: "Pronunciation", purpose: "Teach the voice how to pronounce the household's names.", how: "Household, pronunciation." },
  },
  glance: {
    fr: { name: "Coup d'œil", purpose: "Une vue très courte pour montre ou lunettes : ce qui attend, le prochain rendez-vous.", how: "Mon compte → coup d'œil." },
    en: { name: "Glance", purpose: "A very short view for a watch or glasses: what is waiting, the next appointment.", how: "My account, glance." },
  },
  eink: {
    fr: { name: "Écrans e-ink", purpose: "Afficher un résumé sur un écran e-ink de la maison.", how: "Réglé par l'installation." },
    en: { name: "E-ink screens", purpose: "Show a summary on an e-ink screen at home.", how: "Set by the installation." },
  },
  lokkal_link: {
    fr: { name: "Machine reliée", purpose: "Relier ta machine Lokkal à nokker.ai et passer de l'une à l'autre.", how: "Écran Machine, ou Mon compte → relier une machine." },
    en: { name: "Linked machine", purpose: "Link your Lokkal machine to nokker.ai and move between the two.", how: "Machine screen, or My account, link a machine." },
  },
  folder_mode: {
    fr: { name: "Mode dossier", purpose: "Faire traiter tout un dossier de fichiers d'un coup.", how: "Écran Dossier." },
    en: { name: "Folder mode", purpose: "Have a whole folder of files processed in one go.", how: "Folder screen." },
  },
  lsp: {
    fr: { name: "Diagnostics de code", purpose: "Voir les erreurs du code juste après une modification.", how: "Réglage local.lsp.enabled ; commande /diagnostics du terminal." },
    en: { name: "Code diagnostics", purpose: "See code errors right after a change.", how: "Setting local.lsp.enabled; /diagnostics command in the terminal." },
  },
  project_skills: {
    fr: { name: "Compétences du projet", purpose: "L'agent suit les consignes et compétences rangées dans ton projet.", how: "Réglage local.project_skills ; fichiers du dossier .nokker." },
    en: { name: "Project skills", purpose: "The agent follows the instructions and skills kept in your project.", how: "Setting local.project_skills; files of the .nokker folder." },
  },
  import_codex: {
    fr: { name: "Import de mémoire", purpose: "Reprendre la mémoire d'un autre assistant de code.", how: "Commande « nokker import codex »." },
    en: { name: "Memory import", purpose: "Bring over the memory of another coding assistant.", how: "Command “nokker import codex”." },
  },
  cast: {
    fr: { name: "Écrans du foyer", purpose: "Afficher une page sur la télé ou un écran de la maison.", how: "Réglage local.cast et profil home de l'installation." },
    en: { name: "Home screens", purpose: "Show a page on the TV or a screen at home.", how: "Setting local.cast and the installation's home profile." },
  },
  home_assistant: {
    fr: { name: "Maison connectée", purpose: "Piloter lumières, chauffage et appareils de la maison.", how: "Réglage home_assistant et profil home de l'installation." },
    en: { name: "Smart home", purpose: "Control lights, heating and devices at home.", how: "Setting home_assistant and the installation's home profile." },
  },
  home_watch: {
    fr: { name: "Veille du foyer", purpose: "Surveiller caméras, réseau et stockage de la maison.", how: "Réglage home_watch et profil home de l'installation." },
    en: { name: "Home watch", purpose: "Watch cameras, network and storage at home.", how: "Setting home_watch and the installation's home profile." },
  },
  room_audio: {
    fr: { name: "Voix dans la pièce", purpose: "L'agent annonce un message sur les enceintes d'une pièce.", how: "Réglage ambient.room_audio et profil home." },
    en: { name: "Room audio", purpose: "The agent announces a message on a room's speakers.", how: "Setting ambient.room_audio and the home profile." },
  },
  knock: {
    fr: { name: "Heurtoir", purpose: "Frapper « toc toc toc » pour appeler l'agent, frapper pour approuver.", how: "Réglage knock.enabled et micro de l'installation." },
    en: { name: "Knocker", purpose: "Knock “knock knock knock” to call the agent, knock to approve.", how: "Setting knock.enabled and the installation's microphone." },
  },
};

/** The 53 ids of the core catalogue, in its order (copied from `nokker/guide/catalog.py`). */
export const GUIDE_IDS: readonly string[] = [
  "web_search",
  "images",
  "text_attachments",
  "previews",
  "steer",
  "bubbles",
  "show_me",
  "who_does_what",
  "approvals",
  "telegram",
  "auto_review",
  "approval_suggestions",
  "subagents",
  "delegate_fork",
  "crew",
  "goals",
  "rubric",
  "advisor",
  "plan",
  "incidents",
  "code",
  "execute_code",
  "packs",
  "long_memory",
  "learning",
  "memory_pending",
  "memory_consolidation",
  "connectors",
  "team",
  "sso",
  "household",
  "household_minors",
  "household_paper",
  "family_calendar",
  "payments",
  "house_room",
  "billing",
  "slack",
  "whatsapp",
  "voice",
  "speak_lexicon",
  "glance",
  "eink",
  "lokkal_link",
  "folder_mode",
  "lsp",
  "project_skills",
  "import_codex",
  "cast",
  "home_assistant",
  "home_watch",
  "room_audio",
  "knock",
];
