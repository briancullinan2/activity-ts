import * as path from 'path';

async function generatePost()
{
	// Dynamically load the ESM package inside an async block
	const { getLlama, LlamaChatSession } = await (eval('import("node-llama-cpp")') as Promise<any>);

	console.log('[LLM] Initializing llama.cpp runtime...');
	const llama = await getLlama();

	const modelPath = path.join(__dirname, 'models', 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf');

	const model = await llama.loadModel({
		modelPath
	});

	const context = await model.createContext({
		contextSize: 2048 // Minimized context for maximum token generation speed
	});

	const session = new LlamaChatSession({
		contextSequence: context.getSequence()
	});

	const prompt = 'Write a concise, technical blog post entry about low-level WebAssembly C compilation with WASI-SDK.';

	console.log('[LLM] Generating blog post...\n');

	const response = await session.prompt(prompt, {
		maxTokens: 400,
		temperature: 0.7,
		onToken(tokens: any)
		{
			process.stdout.write(model.detokenize(tokens));
		}
	});

	return response;
}

generatePost().catch(err =>
{
	console.error('[LLM Error]:', err);
	process.exit(1);
});
