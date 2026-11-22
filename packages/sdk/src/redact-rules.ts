/**
 * Copie EMBARQUÉE des règles de masquage (P9b) — GÉNÉRÉE, ne pas éditer à la main : node scripts/gen-redact-rules.mjs.
 * Source qui fait foi : l'export du noyau (nokker 05d3b69, `python -m nokker.redact.export`, mêmes octets que
 * GET /v1/redact/rules), version c3beeeacc5e097b9, 32 règles, 46 vecteurs. Elle ne sert qu'au premier
 * lancement et hors ligne ; dès que le noyau publie un jeu qui passe ses vecteurs, c'est lui qui s'applique.
 */
import type { RedactRules } from "./redact.js";

export const REDACT_RULES_CORE_SHA = "05d3b69";

export const REDACT_RULES_SNAPSHOT: RedactRules = {
  "version": "c3beeeacc5e097b9",
  "rules": [
    {
      "id": "pem",
      "kind": "secret",
      "pattern": "(-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|(?:[A-Za-z0-9+/=\\s]|\\\\[nr])*))",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "anthropic-key",
      "kind": "secret",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])(sk-ant-[A-Za-z0-9_-]{20,})(?![0-9A-Za-z_À-ÖØ-öø-ÿ])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "api-key",
      "kind": "secret",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])(sk-[A-Za-z0-9_-]{20,})(?![0-9A-Za-z_À-ÖØ-öø-ÿ])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "stripe-key",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_])((?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,})(?![A-Za-z0-9_])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "webhook-secret",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_])(whsec_[A-Za-z0-9+/=_-]{20,})",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "github-token",
      "kind": "secret",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])(gh[pousr]_[A-Za-z0-9]{36,})(?![0-9A-Za-z_À-ÖØ-öø-ÿ])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "github-token-2",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_])(github_pat_[A-Za-z0-9_]{22,})(?![A-Za-z0-9_])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "gitlab-token",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_])(gl(?:pat|dt|ptt|rt)-[A-Za-z0-9_-]{20,})",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "slack-token",
      "kind": "secret",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])(xox[abeoprs]-[A-Za-z0-9-]{10,})(?![0-9A-Za-z_À-ÖØ-öø-ÿ])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "slack-token-2",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_])(xapp-[0-9]-[A-Za-z0-9-]{10,})",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "slack-webhook",
      "kind": "secret",
      "pattern": "(https://hooks\\.slack\\.com/services/[A-Za-z0-9/_-]{20,})",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "google-api-key",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_])(AIza[0-9A-Za-z_-]{35})",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "hf-token",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_])(hf_[A-Za-z0-9]{30,})(?![A-Za-z0-9_])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "npm-token",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_])(npm_[A-Za-z0-9]{36})(?![A-Za-z0-9_])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "api-key-2",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_])(sik_[0-9a-f]{32,})(?![A-Za-z0-9_])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "telegram-token",
      "kind": "secret",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])([0-9]{6,10}:[A-Za-z0-9_-]{35})(?![0-9A-Za-z_À-ÖØ-öø-ÿ])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "aws-access-key",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_])((?:AKIA|ASIA)[0-9A-Z]{16})(?![A-Za-z0-9_])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "azure-secret",
      "kind": "secret",
      "pattern": "(?:^|[^A-Za-z0-9_~.-])([A-Za-z0-9_~.-]{3}[0-9]Q~[A-Za-z0-9_~.-]{31,34})(?![A-Za-z0-9_~.-])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "jwt",
      "kind": "secret",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])(eyJ[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{5,})(?![0-9A-Za-z_À-ÖØ-öø-ÿ])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "password-keyword",
      "kind": "secret",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])(?:mot de passe|mdp|password|pw|passwort)(?:(?:\\s+(?:du|de la|de l'|de|des|pour|of|for|for the)\\s+[^\\s,;:=]+){0,2})\\s*[:=]\\s*(\\S+)",
      "group": 1,
      "validate": "none",
      "flags": "i"
    },
    {
      "id": "avs",
      "kind": "avs",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])(756\\.[0-9]{4}\\.[0-9]{4}\\.[0-9]{2}|756[0-9]{10})(?![0-9A-Za-z_À-ÖØ-öø-ÿ])",
      "group": 1,
      "validate": "avs_ean13"
    },
    {
      "id": "iban",
      "kind": "iban",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])([A-Z]{2}[0-9]{2}[A-Z0-9]{9,30})(?![0-9A-Za-z_À-ÖØ-öø-ÿ])",
      "group": 1,
      "validate": "iban_mod97"
    },
    {
      "id": "iban-spaced",
      "kind": "iban",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])([A-Z]{2}[0-9]{2}(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)(?![0-9A-Za-z_À-ÖØ-öø-ÿ])",
      "group": 1,
      "validate": "iban_mod97"
    },
    {
      "id": "card",
      "kind": "card",
      "pattern": "(?:^|[^0-9])([2-6](?:[ \\-]?[0-9]){11,18})(?![0-9])",
      "group": 1,
      "validate": "luhn"
    },
    {
      "id": "email",
      "kind": "email",
      "pattern": "([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,})",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "phone-ch",
      "kind": "phone",
      "pattern": "((?:\\+41|0041)[ .\\-]?[\\(]?0?[\\)]?[ .\\-]?[1-9](?:[ .\\-]?[0-9]){8})",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "phone-ch-national",
      "kind": "phone",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])(0[1-9](?:[ .\\-]?[0-9]){8})(?![0-9A-Za-z_À-ÖØ-öø-ÿ])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "phone-e164",
      "kind": "phone",
      "pattern": "(?:^|[^0-9A-Za-z+])(\\+[1-9](?:[ .\\-]?[0-9]){7,14})(?![0-9])",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "birthdate",
      "kind": "birthdate",
      "pattern": "(?:^|[^0-9])([0-3]?[0-9][./-][01]?[0-9][./-](?:19|20)?[0-9]{2})(?![0-9])",
      "group": 1,
      "validate": "none",
      "context": "né|née|né\\(e\\)|date de naissance|naissance|geb[.]|geboren|geburtsdatum|dob|date of birth|born"
    },
    {
      "id": "address-fr",
      "kind": "address",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])((?:[0-9]{1,4}(?:\\s?(?:bis|ter|[a-c]))?,?[\\s]+)?(?:[rR][uU][eE]|[aA][vV][eE][nN][uU][eE]|[aA][vV]\\.|[cC][hH][eE][mM][iI][nN]|[cC][hH]\\.|[rR][oO][uU][tT][eE]|[rR][tT][eE]|[pP][lL][aA][cC][eE]|[bB][oO][uU][lL][eE][vV][aA][rR][dD]|[bB][dD]|[qQ][uU][aA][iI]|[iI][mM][pP][aA][sS][sS][eE]|[aA][lL][lL][éÉ][eE]|[sS][eE][nN][tT][iI][eE][rR]|[pP][aA][sS][sS][aA][gG][eE]|[rR][uU][eE][lL][lL][eE]|[pP][rR][oO][mM][eE][nN][aA][dD][eE]|[vV][iI][aA][lL][eE]|[pP][iI][aA][zZ][zZ][aA])\\s+(?:(?:[dD][eE]\\s+[lL][aA]|[dD][eE]\\s+[lL]['’]|[dD][uU]|[dD][eE][sS]|[dD][eE]|[dD]['’]|[dD][eE][lL][lL][aA]|[dD][eE][lL])\\s*)?[A-ZÀ-ÖØ-Ý][0-9A-Za-z_À-ÖØ-öø-ÿ'’\\-]+(?:[\\s\\-][A-ZÀ-ÖØ-Ý][0-9A-Za-z_À-ÖØ-öø-ÿ'’\\-]+){0,3}(?:\\s*,?[\\s]*[0-9]{1,4}[\\s]?[a-zA-Z]?(?![0-9A-Za-z_À-ÖØ-öø-ÿ]))?(?:(?:,\\s*|\\n\\s*)[1-9][0-9]{3}[\\s]+[A-ZÀ-ÖØ-Ý][a-zà-ÿ]{2,}(?:[\\s\\-][A-ZÀ-ÖØ-Ý][a-zà-ÿ]+)?)?)",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "address-de",
      "kind": "address",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])([A-ZÄÖÜ][0-9A-Za-z_À-ÖØ-öø-ÿäöüß\\-]*(?:strasse|straße|gasse|weg|platz|allee|ring|rain|halde)\\s+[0-9]{1,4}[\\s]?[a-zA-Z]?(?![0-9A-Za-z_À-ÖØ-öø-ÿ])(?:(?:,\\s*|\\n\\s*)[1-9][0-9]{3}[\\s]+[A-ZÀ-ÖØ-Ý][a-zà-ÿ]{2,}(?:[\\s\\-][A-ZÀ-ÖØ-Ý][a-zà-ÿ]+)?)?)",
      "group": 1,
      "validate": "none"
    },
    {
      "id": "address-en",
      "kind": "address",
      "pattern": "(?:^|[^0-9A-Za-z_À-ÖØ-öø-ÿ])([0-9]{1,5}[\\s]+[A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?[\\s]+(?:Street|St\\.|Avenue|Ave\\.|Road|Rd\\.|Lane|Ln\\.|Drive|Dr\\.|Boulevard|Blvd\\.|Way|Court|Ct\\.)(?:(?:,\\s*|\\n\\s*)[1-9][0-9]{3}[\\s]+[A-ZÀ-ÖØ-Ý][a-zà-ÿ]{2,}(?:[\\s\\-][A-ZÀ-ÖØ-Ý][a-zà-ÿ]+)?)?)",
      "group": 1,
      "validate": "none"
    }
  ],
  "vectors": [
    {
      "text": "Appelle-moi au 079 123 45 67 ou au +41 22 345 67 89.",
      "expect": [
        {
          "kind": "phone",
          "value": "079 123 45 67"
        },
        {
          "kind": "phone",
          "value": "+41 22 345 67 89"
        }
      ]
    },
    {
      "text": "Bureau 0041.22.345.67.89, Paris +33 1 42 68 53 00",
      "expect": [
        {
          "kind": "phone",
          "value": "0041.22.345.67.89"
        },
        {
          "kind": "phone",
          "value": "+33 1 42 68 53 00"
        }
      ]
    },
    {
      "text": "le 12 345, réf. 1234567, +41 79 12",
      "expect": []
    },
    {
      "text": "Écris à Jean.Dupont@example.ch, merci",
      "expect": [
        {
          "kind": "email",
          "value": "Jean.Dupont@example.ch"
        }
      ]
    },
    {
      "text": "jean.dupont at example.ch, user@localhost",
      "expect": []
    },
    {
      "text": "IBAN : CH93 0076 2011 6238 5295 7 pour le loyer",
      "expect": [
        {
          "kind": "iban",
          "value": "CH93 0076 2011 6238 5295 7"
        }
      ]
    },
    {
      "text": "virement DE89370400440532013000 reçu",
      "expect": [
        {
          "kind": "iban",
          "value": "DE89370400440532013000"
        }
      ]
    },
    {
      "text": "IBAN faux : CH93 0076 2011 6238 5295 8 et CH9300762011623852958",
      "expect": []
    },
    {
      "text": "Mon AVS 756.9217.0769.85 et un faux 756.9217.0769.84",
      "expect": [
        {
          "kind": "avs",
          "value": "756.9217.0769.85"
        }
      ]
    },
    {
      "text": "AVS 7569217076985 ; 123.4567.8901.23",
      "expect": [
        {
          "kind": "avs",
          "value": "7569217076985"
        }
      ]
    },
    {
      "text": "Carte 4111 1111 1111 1111, commande 1234 5678 9012 3456",
      "expect": [
        {
          "kind": "card",
          "value": "4111 1111 1111 1111"
        }
      ]
    },
    {
      "text": "carte 5555-5555-5555-4444 ou 378282246310005 ; faux 4242 4242 4242 4241",
      "expect": [
        {
          "kind": "card",
          "value": "5555-5555-5555-4444"
        },
        {
          "kind": "card",
          "value": "378282246310005"
        }
      ]
    },
    {
      "text": "Date de naissance : 14.03.1987 ; rendez-vous le 14.03.2027",
      "expect": [
        {
          "kind": "birthdate",
          "value": "14.03.1987"
        }
      ]
    },
    {
      "text": "née le 3/7/2001, geboren am 01-12-1990",
      "expect": [
        {
          "kind": "birthdate",
          "value": "3/7/2001"
        },
        {
          "kind": "birthdate",
          "value": "01-12-1990"
        }
      ]
    },
    {
      "text": "né le 03.07.85, livré le 03.07.85",
      "expect": [
        {
          "kind": "birthdate",
          "value": "03.07.85"
        }
      ]
    },
    {
      "text": "Livraison : rue du Rhône 42, 1204 Genève",
      "expect": [
        {
          "kind": "address",
          "value": "rue du Rhône 42, 1204 Genève"
        }
      ]
    },
    {
      "text": "Chemin des Crêts 4\n1218 Grand-Saconnex",
      "expect": [
        {
          "kind": "address",
          "value": "Chemin des Crêts 4\n1218 Grand-Saconnex"
        }
      ]
    },
    {
      "text": "j'habite 12 rue de la Paix ; AVENUE du Mail 10",
      "expect": [
        {
          "kind": "address",
          "value": "12 rue de la Paix"
        },
        {
          "kind": "address",
          "value": "AVENUE du Mail 10"
        }
      ]
    },
    {
      "text": "Bahnhofstrasse 1, 8001 Zürich",
      "expect": [
        {
          "kind": "address",
          "value": "Bahnhofstrasse 1, 8001 Zürich"
        }
      ]
    },
    {
      "text": "lives at 221 Baker Street",
      "expect": [
        {
          "kind": "address",
          "value": "221 Baker Street"
        }
      ]
    },
    {
      "text": "la rue est calme, die Bahnhofstrasse ist lang, 221 baker street",
      "expect": []
    },
    {
      "text": "mot de passe : Hunter2!x",
      "expect": [
        {
          "kind": "secret",
          "value": "Hunter2!x"
        }
      ]
    },
    {
      "text": "le password du wifi = Xk9qpzT42",
      "expect": [
        {
          "kind": "secret",
          "value": "Xk9qpzT42"
        }
      ]
    },
    {
      "text": "-----BEGIN " + "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
      "expect": [
        {
          "kind": "secret",
          "value": "-----BEGIN " + "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----"
        }
      ]
    },
    {
      "text": "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
      "expect": []
    },
    {
      "text": "clé sk-ant-AbCdEfGh" + "IjKlMnOpQrStUvWx ici",
      "expect": [
        {
          "kind": "secret",
          "value": "sk-ant-AbCdEfGh" + "IjKlMnOpQrStUvWx"
        }
      ]
    },
    {
      "text": "clé sk-proj-AbCdEfGh" + "IjKlMnOpQrStUvWx ici",
      "expect": [
        {
          "kind": "secret",
          "value": "sk-proj-AbCdEfGh" + "IjKlMnOpQrStUvWx"
        }
      ]
    },
    {
      "text": "clé sk_live_AbCdEfGh" + "IjKlMnOpQrStUvWx ici",
      "expect": [
        {
          "kind": "secret",
          "value": "sk_live_AbCdEfGh" + "IjKlMnOpQrStUvWx"
        }
      ]
    },
    {
      "text": "clé whsec_AbCdEfGhI" + "jKlMnOpQrStUvWx ici",
      "expect": [
        {
          "kind": "secret",
          "value": "whsec_AbCdEfGhI" + "jKlMnOpQrStUvWx"
        }
      ]
    },
    {
      "text": "clé ghp_AbCdEfGhIjKlMnOp" + "QrStUvWxYz0123456789 ici",
      "expect": [
        {
          "kind": "secret",
          "value": "ghp_AbCdEfGhIjKlMnOp" + "QrStUvWxYz0123456789"
        }
      ]
    },
    {
      "text": "clé github_pat_AbCdEf" + "GhIjKlMnOpQrStUvWx ici",
      "expect": [
        {
          "kind": "secret",
          "value": "github_pat_AbCdEf" + "GhIjKlMnOpQrStUvWx"
        }
      ]
    },
    {
      "text": "clé glpat-AbCdEfGhI" + "jKlMnOpQrStUvWx ici",
      "expect": [
        {
          "kind": "secret",
          "value": "glpat-AbCdEfGhI" + "jKlMnOpQrStUvWx"
        }
      ]
    },
    {
      "text": "clé xoxb-123456789" + "0-AbCdEfGhIjKl ici",
      "expect": [
        {
          "kind": "secret",
          "value": "xoxb-123456789" + "0-AbCdEfGhIjKl"
        }
      ]
    },
    {
      "text": "clé xapp-1-Ab" + "CdEfGhIjKl ici",
      "expect": [
        {
          "kind": "secret",
          "value": "xapp-1-Ab" + "CdEfGhIjKl"
        }
      ]
    },
    {
      "text": "clé https://hooks.slack.com/service" + "s/T0/B0/AbCdEfGhIjKlMnOpQrStUvWx ici",
      "expect": [
        {
          "kind": "secret",
          "value": "https://hooks.slack.com/service" + "s/T0/B0/AbCdEfGhIjKlMnOpQrStUvWx"
        }
      ]
    },
    {
      "text": "clé AIzaAbCdEfGhIjKlMnO" + "pQrStUvWxYz012345678 ici",
      "expect": [
        {
          "kind": "secret",
          "value": "AIzaAbCdEfGhIjKlMnO" + "pQrStUvWxYz012345678"
        }
      ]
    },
    {
      "text": "clé hf_AbCdEfGhIjKlMn" + "OpQrStUvWxYz012345 ici",
      "expect": [
        {
          "kind": "secret",
          "value": "hf_AbCdEfGhIjKlMn" + "OpQrStUvWxYz012345"
        }
      ]
    },
    {
      "text": "clé npm_AbCdEfGhIjKlMnOp" + "QrStUvWxYz0123456789 ici",
      "expect": [
        {
          "kind": "secret",
          "value": "npm_AbCdEfGhIjKlMnOp" + "QrStUvWxYz0123456789"
        }
      ]
    },
    {
      "text": "clé sik_0123456789abcd" + "ef0123456789abcdef ici",
      "expect": [
        {
          "kind": "secret",
          "value": "sik_0123456789abcd" + "ef0123456789abcdef"
        }
      ]
    },
    {
      "text": "clé 123456789:AbCdEfGhIjKl" + "MnOpQrStUvWxYz012345678 ici",
      "expect": [
        {
          "kind": "secret",
          "value": "123456789:AbCdEfGhIjKl" + "MnOpQrStUvWxYz012345678"
        }
      ]
    },
    {
      "text": "clé AKIAABCDEF" + "GHIJKLMNOP ici",
      "expect": [
        {
          "kind": "secret",
          "value": "AKIAABCDEF" + "GHIJKLMNOP"
        }
      ]
    },
    {
      "text": "clé abc1Q~AbCdEfGhIjKlM" + "nOpQrStUvWxYz012345 ici",
      "expect": [
        {
          "kind": "secret",
          "value": "abc1Q~AbCdEfGhIjKlM" + "nOpQrStUvWxYz012345"
        }
      ]
    },
    {
      "text": "clé eyJhbGciOi.eyJzd" + "WIiOi.SflKxwRJSM ici",
      "expect": [
        {
          "kind": "secret",
          "value": "eyJhbGciOi.eyJzd" + "WIiOi.SflKxwRJSM"
        }
      ]
    },
    {
      "text": "clés courtes sk-court ghp_court xoxb-x AKIAcourt eyJ.a.b",
      "expect": []
    },
    {
      "text": "Total 89.90 CHF, facture 2026-114, tél. ⟦PHONE-1⟧, ⟦IBAN-2⟧, ⟦AHV-1⟧ ⟦CARD-9999⟧ ⟦SECRET-3⟧",
      "expect": []
    },
    {
      "text": "mot de passe : ⟦SECRET-1⟧ ; née le ⟦BIRTHDATE-1⟧",
      "expect": []
    }
  ]
};
