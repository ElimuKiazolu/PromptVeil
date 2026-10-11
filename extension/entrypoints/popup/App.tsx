import markUrl from '@/assets/brand/mark.svg';

function App() {
  return (
    <main className="w-[360px] bg-mist p-4 font-sans">
      <h1 className="flex items-center gap-2 text-xl font-medium text-spruce">
        <img src={markUrl} alt="" width={24} height={24} />
        PromptVeil
      </h1>
      <p className="mt-1 text-graphite">Setup in progress</p>
    </main>
  );
}

export default App;
