import { useState } from 'react';
import { ArrowRight, BrainCircuit, CloudOff, FileText, HardDrive, Mic, ShieldCheck, Sparkles } from 'lucide-react';
import { PROVIDER_INFO } from '@shared/providers';
import { Button } from '../../design/components';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
import { BrandMark } from '../../shell/Shell';
import { KeyForm } from '../transcript/ProvidersScreen';


export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [offlineOnly, setOfflineOnly] = useState(true);
  const toast = useToast();
  const steps = offlineOnly ? 3 : 4;

  const finish = () => {
    api.updateSettings({ onboardingComplete: true, displayName: name.trim(), offlineOnly }).then(onDone, toast.showError);
  };

  return (
    <div className="onboarding">
      <div className="titlebar" />
      <div className="onboarding-body">
        <div className="onboarding-card">
          <div className="onboarding-steps" aria-label={`Step ${step + 1} of ${steps}`}>
            {Array.from({ length: steps }, (_, i) => (
              <span key={i} className={i <= step ? 'on' : ''} />
            ))}
          </div>

          {step === 0 && (
            <>
              <BrandMark size={52} />
              <div className="stack">
                <h1>Turn every recording into knowledge</h1>
                <p className="muted">Record or import any audio. EchoMind helps you turn it into transcripts, notes, documents and answers.</p>
              </div>
              <div className="stack">
                <div className="feature-line">
                  <Mic size={18} aria-hidden />
                  <span>Reliable recording that survives crashes</span>
                </div>
                <div className="feature-line">
                  <BrainCircuit size={18} aria-hidden />
                  <span>The same AI tools for recorded and imported audio</span>
                </div>
                <div className="feature-line">
                  <FileText size={18} aria-hidden />
                  <span>Real PDF, Word and PowerPoint files</span>
                </div>
              </div>
              <Button variant="primary" size="lg" trailingIcon={ArrowRight} onClick={() => setStep(1)}>
                Get started
              </Button>
            </>
          )}

          {step === 1 && (
            <>
              <div className="stack">
                <h1>What should we call you?</h1>
                <p className="muted">Optional. This stays on your computer and only personalizes the Home screen.</p>
              </div>
              <form
                className="stack"
                onSubmit={(e) => {
                  e.preventDefault();
                  setStep(2);
                }}
              >
                <input className="input" aria-label="Your name" placeholder="Your name" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
                <Button variant="primary" size="lg" trailingIcon={ArrowRight} type="submit">
                  Continue
                </Button>
              </form>
            </>
          )}

          {step === 2 && (
            <>
              <div className="stack">
                <h1>Your recordings stay private</h1>
                <p className="muted">Recordings live on this computer. You decide whether AI features may send anything to a cloud service.</p>
              </div>
              <div className="stack" role="radiogroup" aria-label="Privacy choice">
                <button type="button" className="choice" role="radio" aria-checked={offlineOnly} onClick={() => setOfflineOnly(true)}>
                  <CloudOff size={20} aria-hidden />
                  <span>
                    <h3>Offline only (recommended to start)</h3>
                    <span className="muted small">Nothing leaves this computer. Recording, importing and your library all work. You can change this any time.</span>
                  </span>
                </button>
                <button type="button" className="choice" role="radio" aria-checked={!offlineOnly} onClick={() => setOfflineOnly(false)}>
                  <Sparkles size={20} aria-hidden />
                  <span>
                    <h3>Allow AI features with my own free key</h3>
                    <span className="muted small">Nothing is sent yet. Before the first upload to any provider, EchoMind explains what is sent and asks you to agree.</span>
                  </span>
                </button>
              </div>
              <div className="feature-line muted small">
                <ShieldCheck size={16} aria-hidden />
                <span>EchoMind has no account, no payments and no tracking.</span>
              </div>
              <div className="feature-line muted small">
                <HardDrive size={16} aria-hidden />
                <span>Your data folder is shown in Settings.</span>
              </div>
              {offlineOnly ? (
                <Button variant="primary" size="lg" trailingIcon={ArrowRight} onClick={finish}>
                  Start using EchoMind
                </Button>
              ) : (
                <Button variant="primary" size="lg" trailingIcon={ArrowRight} onClick={() => setStep(3)}>
                  Continue
                </Button>
              )}
            </>
          )}

          {step === 3 && (
            <>
              <div className="stack">
                <h1>Add a free transcription key</h1>
                <p className="muted">
                  {PROVIDER_INFO.groq.label} turns speech into text. Create a free key on its site, then paste it here. It is encrypted on this computer. You can also do this later in Settings.
                </p>
              </div>
              <button type="button" className="link small" style={{ alignSelf: 'flex-start' }} onClick={() => void api.openExternal(PROVIDER_INFO.groq.keyUrl!)}>
                Get a free Groq key
              </button>
              <KeyForm provider="groq" onSaved={finish} />
              <Button variant="ghost" onClick={finish}>
                Skip for now
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
