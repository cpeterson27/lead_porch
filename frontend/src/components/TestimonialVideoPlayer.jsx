import { useState } from "react";
import { FaCirclePlay } from "react-icons/fa6";
import "./TestimonialVideoPlayer.css";

// Shows the chosen cover frame full-size with a play button over it; clicking
// swaps in the real <video> and starts it. Used on both the public homepage
// and the admin editor's preview so they always match exactly.
export default function TestimonialVideoPlayer({ videoUrl, coverUrl, className = "" }) {
  const [playing, setPlaying] = useState(false);
  if (!videoUrl) return null;
  if (playing)
    return (
      <video
        className={`testimonial-video-player ${className}`.trim()}
        src={videoUrl}
        poster={coverUrl || undefined}
        controls
        autoPlay
        controlsList="nodownload noremoteplayback"
        disablePictureInPicture
        playsInline
        onContextMenu={(event) => event.preventDefault()}
      />
    );
  return (
    <button
      type="button"
      className={`testimonial-video-cover ${className}`.trim()}
      onClick={() => setPlaying(true)}
      aria-label="Play video"
      style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : undefined}
    >
      <span className="testimonial-video-cover__play">
        <FaCirclePlay aria-hidden="true" />
      </span>
    </button>
  );
}
