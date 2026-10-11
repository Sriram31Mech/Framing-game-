import { useMe } from '../api/queries';
import { signOutLocally } from '../api/client';
import { describeError } from '../api/errors';
import { AuthScreen } from '../features/auth/AuthScreen';
import { CreateCompanyScreen } from '../features/company/CreateCompanyScreen';
import { useRealtime } from '../realtime/useRealtime';
import { useAuthStore } from '../store/auth';
import { GameScreen } from './GameScreen';
import { Splash } from './Splash';

function AuthedRoot() {
  const me = useMe();
  useRealtime(true);
  if (me.data) {
    if (!me.data.company) return <CreateCompanyScreen me={me.data} />;
    return <GameScreen me={me.data} />;
  }
  if (me.isError) {
    const d = describeError(me.error);
    return (
      <Splash
        message=""
        error={`${d.title}. ${d.message}`}
        onRetry={() => void me.refetch()}
        onSignOut={() => signOutLocally()}
      />
    );
  }
  return <Splash message="Opening your company books…" />;
}

export function App() {
  const token = useAuthStore((s) => s.token);
  return token ? <AuthedRoot /> : <AuthScreen />;
}
