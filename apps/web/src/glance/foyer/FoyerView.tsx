/**
 * F1 — vue « Foyer » de l'écran mural, lisible à 2 m : agenda du jour par personne (couleur + initiale, jamais la
 * couleur seule), tâches du jour cochables au doigt, repas et courses, météo et départs, projets du foyer, états de la
 * maison en lecture seule. Le noyau a filtré (droits du foyer, mode invité) ; cette vue n'affiche que ce qu'elle reçoit
 * et masque une tuile vide. Une coche n'a aucun effet hors du foyer.
 */
import React, { useState } from "react";
import type { GlanceHousehold, HouseholdTask, ShoppingItem, WallMember } from "@nokker-apps/sdk";
import { tr } from "../../i18n/index.js";
import { FlowBox } from "../../pretext/FlowBox.js";
import { Icon } from "../../icons.js";
import { dayName, eventText, haText, mealDay, mealsAhead, memberOf, pct, splitAgenda, weatherIcon } from "./model.js";
import "./foyer.css";

function Chip({ m }: { m: WallMember | null }): React.ReactElement {
  return m ? (
    <span className="fy-chip" style={{ background: m.color }} aria-label={m.name} title={m.name}>
      {m.initials}
    </span>
  ) : (
    <span className="fy-chip all" aria-label={tr("Everyone")} title={tr("Everyone")}>
      ∗
    </span>
  );
}

function Check({ done, label, onToggle, busy, id }: { done: boolean; label: React.ReactNode; onToggle: () => void; busy: boolean; id: string }): React.ReactElement {
  return (
    <button type="button" className={`fy-check ${done ? "done" : ""}`} aria-pressed={done} disabled={busy} onClick={onToggle} data-fy-check={id}>
      <span className="fy-box" aria-hidden="true">
        {done ? "✓" : ""}
      </span>
      {typeof label === "string" ? <FlowBox as="span" className="fy-check-text" text={label}>{label}</FlowBox> : <span className="fy-check-text">{label}</span>}
    </button>
  );
}

export interface FoyerActions {
  task(id: string, done: boolean): Promise<void>;
  shopping(id: string, done: boolean): Promise<void>;
}

export function FoyerView({ h, now, lang, actions }: { h: GlanceHousehold; now: Date; lang: string; actions: FoyerActions }): React.ReactElement {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const agenda = splitAgenda(h, now);
  const meals = mealsAhead(h, now);
  const run = async (key: string, f: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setErr(false);
    try {
      await f();
    } catch {
      setErr(true);
      window.setTimeout(() => setErr(false), 6000);
    } finally {
      setBusy(null);
    }
  };
  const byMember = (t: HouseholdTask[]): { m: WallMember | null; tasks: HouseholdTask[] }[] => {
    const groups: { m: WallMember | null; tasks: HouseholdTask[] }[] = [];
    for (const m of h.members) {
      const mine = t.filter((x) => x.member_id === m.id);
      if (mine.length) groups.push({ m, tasks: mine });
    }
    const shared = t.filter((x) => !x.member_id || !memberOf(h.members, x.member_id));
    if (shared.length) groups.push({ m: null, tasks: shared });
    return groups;
  };
  const open = (s: ShoppingItem[]): ShoppingItem[] => [...s.filter((x) => !x.done), ...s.filter((x) => x.done)];
  return (
    <div className="fy" data-fy-guest={h.guest ? "1" : "0"}>
      {h.weather || h.departures.length ? (
        <section className="fy-tile fy-outside" aria-label={tr("Outside")}>
          {h.weather ? (
            <p className="fy-weather" data-fy-weather>
              <span className="fy-wx" aria-hidden="true">
                <Icon name={weatherIcon(h.weather.code, h.weather.summary)} />
              </span>
              {h.weather.now_c !== null && h.weather.now_c !== undefined ? <span className="fy-temp">{Math.round(h.weather.now_c)}°</span> : null}
              <span className="fy-wx-sum">
                <span>{h.weather.summary}</span>
                <span className="fy-hilo">{tr("{0}° / {1}°", Math.round(h.weather.hi_c), Math.round(h.weather.lo_c))}</span>
              </span>
            </p>
          ) : null}
          {h.departures.length ? (
            <ul className="fy-deps" data-fy-departures>
              {h.departures.slice(0, 3).map((d, i) => (
                <li key={i}>
                  <span className="fy-line">{d.line}</span>
                  <span className="fy-to">{d.to}</span>
                  <span className="fy-min">{d.minutes <= 0 ? tr("now") : tr("{0} min", d.minutes)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="fy-tile fy-agenda" aria-labelledby="fy-agenda-h" data-fy-agenda>
        <h2 id="fy-agenda-h">{tr("Today")}</h2>
        {agenda.today.length ? (
          <ul className="fy-events">
            {agenda.today.map((e) => (
              <li key={e.id} data-fy-event={e.id}>
                <Chip m={memberOf(h.members, e.member_id)} />
                <span>{eventText(e, lang)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fy-empty">{tr("Nothing else today.")}</p>
        )}
        {agenda.later.map((g) => (
          <div key={g.day.toISOString()} className="fy-later">
            <h3>{dayName(g.day, now, lang)}</h3>
            <ul className="fy-events small">
              {g.events.slice(0, 3).map((e) => (
                <li key={e.id}>
                  <Chip m={memberOf(h.members, e.member_id)} />
                  <span>{eventText(e, lang)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {h.tasks.length ? (
        <section className="fy-tile fy-tasks" aria-labelledby="fy-tasks-h" data-fy-tasks>
          <h2 id="fy-tasks-h">{tr("Tasks of the day")}</h2>
          {byMember(h.tasks).map((g) => (
            <div key={g.m?.id ?? "all"} className="fy-group">
              <p className="fy-who">
                <Chip m={g.m} />
                <span>{g.m ? g.m.name : tr("Everyone")}</span>
              </p>
              {g.tasks.map((t) => (
                <Check key={t.id} id={t.id} done={t.done} busy={busy === t.id} label={t.title} onToggle={() => void run(t.id, () => actions.task(t.id, !t.done))} />
              ))}
            </div>
          ))}
        </section>
      ) : null}

      {meals.length || h.shopping.length ? (
        <section className="fy-tile fy-food" aria-labelledby="fy-food-h" data-fy-food>
          <h2 id="fy-food-h">{tr("Meals and shopping")}</h2>
          {meals.map((m) => (
            <div key={m.date} className="fy-meal">
              <h3>{mealDay(m.date, now, lang)}</h3>
              {m.lunch ? <p>{tr("Lunch: {0}", m.lunch)}</p> : null}
              {m.dinner ? <p>{tr("Dinner: {0}", m.dinner)}</p> : null}
            </div>
          ))}
          {h.shopping.length ? (
            <div className="fy-shop" data-fy-shopping>
              <h3>{tr("Shopping list")}</h3>
              {open(h.shopping).map((s) => (
                <Check key={s.id} id={s.id} done={s.done} busy={busy === s.id} label={s.text} onToggle={() => void run(s.id, () => actions.shopping(s.id, !s.done))} />
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {h.projects.length ? (
        <section className="fy-tile fy-projects" aria-labelledby="fy-proj-h" data-fy-projects>
          <h2 id="fy-proj-h">{tr("Household projects")}</h2>
          {h.projects.map((p) => (
            <div key={p.id} className="fy-proj">
              <p className="fy-proj-title">
                <FlowBox as="span" text={p.title}>{p.title}</FlowBox>
                <span className="fy-pct">{tr("{0} %", pct(p.progress))}</span>
              </p>
              <div className="fy-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(p.progress)} aria-label={p.title}>
                <span style={{ width: `${pct(p.progress)}%` }} />
              </div>
              {p.next_step ? <p className="fy-next">{tr("Next: {0}", p.next_step)}</p> : null}
            </div>
          ))}
        </section>
      ) : null}

      {h.ha.length ? (
        <section className="fy-tile fy-ha" aria-label={tr("Home")} data-fy-ha>
          {h.ha.map((s) => (
            <span key={s.entity_id} className={`fy-ha-chip d-${s.domain} ${s.state === "on" ? "on" : ""}`}>
              <span className="fy-ha-name">{s.name}</span>
              <span className="fy-ha-state">{haText(s)}</span>
            </span>
          ))}
        </section>
      ) : null}
      {err ? (
        <p className="fy-err" role="status">
          {tr("Not saved: the wall could not reach Nokker. Try again in a moment.")}
        </p>
      ) : null}
    </div>
  );
}
