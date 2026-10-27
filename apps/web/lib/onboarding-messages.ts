const guides = {
  en: {
    title: 'Make yourself at home',
    description: 'A few steps to set up your shared workspace.',
    done: 'Complete',
    close: 'Close guide',
    progress: 'completed',
    steps: [
      'Set up your profile',
      'Start a conversation',
      'Create your first task',
      'Write a knowledge page',
      'Choose your notifications',
    ],
  },
  es: {
    title: 'Tu espacio de trabajo',
    description: 'Configura tu espacio compartido en unos pasos.',
    done: 'Completar',
    close: 'Cerrar guía',
    progress: 'completados',
    steps: [
      'Configura tu perfil',
      'Inicia una conversación',
      'Crea tu primera tarea',
      'Escribe una página de conocimiento',
      'Elige tus notificaciones',
    ],
  },
  hi: {
    title: 'अपना कार्यस्थान तैयार करें',
    description: 'अपने साझा कार्यस्थान को कुछ चरणों में तैयार करें।',
    done: 'पूरा करें',
    close: 'मार्गदर्शिका बंद करें',
    progress: 'पूरे हुए',
    steps: [
      'अपनी प्रोफ़ाइल सेट करें',
      'बातचीत शुरू करें',
      'अपना पहला कार्य बनाएँ',
      'ज्ञान पृष्ठ लिखें',
      'सूचनाएँ चुनें',
    ],
  },
  fr: {
    title: 'Bienvenue dans votre espace',
    description: 'Quelques étapes pour configurer votre espace partagé.',
    done: 'Terminer',
    close: 'Fermer le guide',
    progress: 'terminées',
    steps: [
      'Configurez votre profil',
      'Lancez une conversation',
      'Créez votre première tâche',
      'Rédigez une page de connaissances',
      'Choisissez vos notifications',
    ],
  },
  de: {
    title: 'Richten Sie sich ein',
    description: 'Einige Schritte für Ihren gemeinsamen Arbeitsbereich.',
    done: 'Abschließen',
    close: 'Anleitung schließen',
    progress: 'abgeschlossen',
    steps: [
      'Profil einrichten',
      'Unterhaltung starten',
      'Erste Aufgabe erstellen',
      'Wissensseite schreiben',
      'Benachrichtigungen wählen',
    ],
  },
  ja: {
    title: 'ワークスペースを整えましょう',
    description: '共有ワークスペースを設定するための簡単な手順です。',
    done: '完了',
    close: 'ガイドを閉じる',
    progress: '完了',
    steps: [
      'プロフィールを設定',
      '会話を始める',
      '最初のタスクを作成',
      'ナレッジページを作成',
      '通知を選択',
    ],
  },
} as const;
export function guideMessages(locale: string) {
  const base = locale.split('-')[0] ?? 'en';
  return guides[base as keyof typeof guides] ?? guides.en;
}
