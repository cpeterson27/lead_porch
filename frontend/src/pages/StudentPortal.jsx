import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { completeStudentModule, fetchStudentPortal } from "../services/api.js";
import "./StudentPortal.css";

const resourceIcon = { video: "🎬", pdf: "📄", worksheet: "📝", script: "🗒️", template: "📋", link: "🔗" };

export default function StudentPortal() {
  const { token } = useParams();
  const [portal, setPortal] = useState(null);
  const [error, setError] = useState("");
  const [completingId, setCompletingId] = useState("");
  const load = () => fetchStudentPortal(token).then(setPortal).catch((requestError) => setError(requestError.response?.data?.error || "This portal link could not be opened."));
  useEffect(() => { load(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const complete = async (moduleId) => {
    setCompletingId(moduleId);
    try { setPortal(await completeStudentModule(token, moduleId)); }
    catch (requestError) { setError(requestError.response?.data?.error || "Unable to mark that complete."); }
    finally { setCompletingId(""); }
  };

  if (error && !portal) return <main className="student-portal"><section className="student-portal__panel"><p className="student-portal__eyebrow">Student portal</p><h1>We couldn't open this</h1><p>{error}</p></section></main>;
  if (!portal) return <main className="student-portal"><section className="student-portal__panel"><p>Loading your portal…</p></section></main>;

  const percent = portal.progress.total ? Math.round((portal.progress.completed / portal.progress.total) * 100) : 0;

  return <main className="student-portal">
    <section className="student-portal__panel">
      <p className="student-portal__eyebrow">{portal.program.name}</p>
      <h1>Welcome back{portal.student.name ? `, ${portal.student.name.split(" ")[0]}` : ""}</h1>
      {portal.program.description ? <p className="student-portal__intro">{portal.program.description}</p> : null}

      <div className="student-portal__progress">
        <div className="student-portal__progress-bar"><div style={{ width: `${percent}%` }} /></div>
        <span>{portal.progress.completed} of {portal.progress.total} weeks complete</span>
      </div>

      {portal.upcomingSessions?.length ? (
        <div className="student-portal__sessions">
          <h2>Upcoming sessions</h2>
          {portal.upcomingSessions.map((session) => (
            <div className="student-portal__session" key={session._id}>
              <span>{new Date(session.startsAt).toLocaleString()} · {session.durationMinutes} min</span>
              {session.zoom?.joinUrl ? <a href={session.zoom.joinUrl} target="_blank" rel="noreferrer">Join Zoom</a> : session.calendar?.htmlLink ? <a href={session.calendar.htmlLink} target="_blank" rel="noreferrer">View on calendar</a> : null}
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p className="student-portal__error" role="alert">{error}</p> : null}

      <div className="student-portal__weeks">
        {portal.modules.map((module) => (
          <article className={`student-portal__week${module.unlocked ? "" : " is-locked"}${module.completed ? " is-complete" : ""}`} key={module._id}>
            <header>
              <span className="student-portal__week-number">Week {module.weekNumber}</span>
              <h3>{module.title}</h3>
              {module.completed ? <span className="student-portal__badge">Complete</span> : !module.unlocked ? <span className="student-portal__badge student-portal__badge--locked">Unlocks {new Date(module.unlocksAt).toLocaleDateString()}</span> : null}
            </header>
            {module.unlocked ? <>
              {module.description ? <p>{module.description}</p> : null}
              {module.resources?.length ? <ul className="student-portal__resources">{module.resources.map((resource) => <li key={resource.url}><a href={resource.url} target="_blank" rel="noreferrer">{resourceIcon[resource.type] || "🔗"} {resource.title}</a></li>)}</ul> : null}
              {module.homeworkPrompt ? <div className="student-portal__homework"><strong>This week's homework</strong><p>{module.homeworkPrompt}</p></div> : null}
              {!module.completed ? <button type="button" onClick={() => complete(module._id)} disabled={completingId === module._id}>{completingId === module._id ? "Saving…" : "Mark this week complete"}</button> : null}
            </> : <p className="student-portal__locked-note">This week isn't available yet — check back after {new Date(module.unlocksAt).toLocaleDateString()}.</p>}
          </article>
        ))}
      </div>
    </section>
  </main>;
}
