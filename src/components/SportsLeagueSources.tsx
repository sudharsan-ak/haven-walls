import { useEffect, useState, type FormEvent } from "react";
import {
  DEFAULT_SPORTS_LEAGUES, loadSportsLeagues, MAX_LEAGUES,
  MAX_WEBSITES, normalizeLeagueWebsite, saveSportsLeagues,
  sportsWallpaperSearch, validLeagueName, type SportsLeague,
} from "../lib/sportsLeagues";
import "./SportsLeagueSources.css";
import ConfirmDialog from "./ConfirmDialog";

interface Props {
  teamName: string;
  onSearchWeb: (query: string) => void;
}

export default function SportsLeagueSources({ teamName, onSearchWeb }: Props) {
  const [leagues, setLeagues] = useState<SportsLeague[]>(loadSportsLeagues);
  const [leagueId, setLeagueId] = useState(() => loadSportsLeagues()[0]?.id || "");
  const [newLeague, setNewLeague] = useState("");
  const [newWebsite, setNewWebsite] = useState("");
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(true);
  const [pendingAction, setPendingAction] = useState<"remove" | "reset" | null>(null);

  useEffect(() => {
    setSaved(saveSportsLeagues(leagues));
  }, [leagues]);

  const league = leagues.find((item) => item.id === leagueId) ?? leagues[0] ?? null;

  function addLeague(event: FormEvent) {
    event.preventDefault();
    const name = validLeagueName(newLeague);
    if (!name) {
      setMessage("Enter a league name between 2 and 45 characters.");
      return;
    }
    if (leagues.length >= MAX_LEAGUES) {
      setMessage("Maximum of 25 leagues reached.");
      return;
    }
    if (leagues.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
      setMessage("That league already exists. Select it from the list.");
      return;
    }
    const id = "league-" + crypto.randomUUID().slice(0, 12);
    setLeagues((items) => [...items, { id, name, websites: [] }]);
    setLeagueId(id);
    setNewLeague("");
    setNewWebsite("");
    setMessage("League added. Enter its preferred image websites below.");
  }

  function addWebsite(event: FormEvent) {
    event.preventDefault();
    if (!league) return;
    const website = normalizeLeagueWebsite(newWebsite);
    if (!website) {
      setMessage("Enter a valid HTTPS website or domain, e.g. wnba.com or espn.com/wnba.");
      return;
    }
    if (league.websites.includes(website)) {
      setMessage("This site is already saved for the selected league.");
      return;
    }
    if (league.websites.length >= MAX_WEBSITES) {
      setMessage("Maximum of 10 websites per league reached.");
      return;
    }
    setLeagues((items) => items.map((item) => item.id === league.id
      ? { ...item, websites: [...item.websites, website] } : item));
    setNewWebsite("");
    setMessage("Website added. Searches can now be narrowed to " + website + ".");
  }

  function removeWebsite(website: string) {
    if (!league) return;
    setLeagues((items) => items.map((item) => item.id === league.id
      ? { ...item, websites: item.websites.filter((site) => site !== website) } : item));
    setMessage("Website removed from " + league.name + ".");
  }

  function removeLeague() {
    if (!league) return;
    const remaining = leagues.filter((item) => item.id !== league.id);
    setLeagues(remaining);
    setLeagueId(remaining[0]?.id ?? "");
    setMessage(league.name + " removed.");
  }

  function search(sites: string[]) {
    if (!league) return;
    const query = sportsWallpaperSearch(league, teamName, sites);
    if (!query) {
      setMessage("Search is too long for the selected websites. Search one website at a time.");
      return;
    }
    onSearchWeb(query);
  }

  function reset() {

    const defaults = DEFAULT_SPORTS_LEAGUES.map((item) => ({ ...item, websites: [...item.websites] }));
    setLeagues(defaults);
    setLeagueId(defaults[0].id);
    setMessage("Default league websites restored.");
  }

  return (
    <section className="sls-panel" aria-label="Sports league image websites">
      <div className="sls-heading">
        <div>
          <h2>League image websites</h2>
          <p>Choose websites for each league. Haven Walls searches Google Images within those sites; it does not scrape or download from them automatically.</p>
        </div>
        <button type="button" className="online-secondary" onClick={() => setPendingAction("reset")}>Restore defaults</button>
      </div>

      <div className="sls-line">
        <div className="sls-control">
          <label htmlFor="sls-league">League</label>
          <select id="sls-league" value={league?.id || ""}
            onChange={(event) => {
              setLeagueId(event.target.value);
              setNewWebsite("");
              setMessage("");
            }}>
            {leagues.length === 0 && <option value="">Add a league below</option>}
            {leagues.map((entry) => (
              <option key={entry.id} value={entry.id}>{entry.name}</option>
            ))}
          </select>
        </div>
        <form className="sls-add-league" onSubmit={addLeague}>
          <label htmlFor="sls-league-add">Add a league, such as WNBA</label>
          <div className="sls-inline">
            <input id="sls-league-add" value={newLeague} maxLength={45}
              onChange={(event) => setNewLeague(event.target.value)}
              placeholder="WNBA, NFL, Formula 1…" />
            <button type="submit" className="online-secondary">Add league</button>
          </div>
        </form>
      </div>

      {league && (
        <>
          <div className="sls-site-heading">
            <strong>Preferred image websites for {league.name}</strong>
            <button type="button" className="sls-text-action" onClick={() => setPendingAction("remove")}>
              Remove league
            </button>
          </div>
          <div className="sls-site-list">
            {league.websites.length === 0 && <p>No websites yet. Add a site below or search everywhere.</p>}
            {league.websites.map((site) => (
              <div className="sls-site" key={site}>
                <span className="sls-site-domain" title={site}>{site}</span>
                <button type="button" className="sls-site-search" title={"Search images on " + site}
                  onClick={() => search([site])}>Search site</button>
                <button type="button" className="sls-site-remove" title={"Remove " + site}
                  aria-label={"Remove " + site} onClick={() => removeWebsite(site)}>×</button>
              </div>
            ))}
          </div>
          <form onSubmit={addWebsite} className="sls-site-form">
            <label htmlFor="sls-new-website">Add an official site or another image website</label>
            <div className="sls-inline">
              <input id="sls-new-website" value={newWebsite} maxLength={220}
                onChange={(event) => setNewWebsite(event.target.value)}
                placeholder="https://www.wnba.com or espn.com/wnba" />
              <button type="submit" className="online-secondary">Add website</button>
            </div>
          </form>
          <div className="sls-actions">
            <button type="button" className="online-primary"
              disabled={league.websites.length === 0}
              onClick={() => search(league.websites)}>
              Search saved websites
            </button>
            <button type="button" className="online-secondary"
              onClick={() => search([])}>
              Search all websites
            </button>
            <span>Using the team above: <strong>{teamName.trim() || league.name}</strong></span>
          </div>
        </>
      )}

      {message && <p className="sls-message" role="status">{message}</p>}
      {!saved && <p className="sls-warning" role="alert">
        Could not save these league settings locally. They may reset when the app closes.
      </p>}
      <p className="sls-footnote">
        Site searches use Google's site: operator. Adding a website doesn't guarantee available wallpaper-sized images or permission to reuse them. The saved league list stays on this PC.
      </p>
      {pendingAction && (
        <ConfirmDialog
          tone={pendingAction === "remove" ? "danger" : "warning"}
          title={pendingAction === "remove" ? "Remove sports league?" : "Restore default sports websites?"}
          description={pendingAction === "remove"
            ? "Remove " + (league?.name || "this league") + " from Haven Walls?"
            : "Reset the saved sports league and website list to the defaults?"}
          note={pendingAction === "remove"
            ? "The league and its saved image websites are removed from this app."
            : "Your custom leagues and websites will be replaced with the initial NBA and IPL setup."}
          confirmLabel={pendingAction === "remove" ? "Remove league" : "Restore defaults"}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => {
            if (pendingAction === "remove") removeLeague();
            else reset();
            setPendingAction(null);
          }} />
      )}
    </section>
  );
}
