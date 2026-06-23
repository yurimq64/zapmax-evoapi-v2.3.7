import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify user
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: authUser }, error: authError } = await userClient.auth.getUser();
    if (authError || !authUser) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = { id: authUser.id };

    const { messages, tenant_id } = await req.json();
    if (!messages || !Array.isArray(messages) || !tenant_id) {
      return new Response(JSON.stringify({ success: false, error: "Invalid payload" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Verify user is tenant member
    const { data: isMember } = await adminClient.rpc("is_tenant_member", {
      _user_id: user.id,
      _tenant_id: tenant_id,
    });
    if (!isMember) {
      return new Response(JSON.stringify({ success: false, error: "Forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load AI settings
    const { data: aiSettings } = await adminClient
      .from("ai_settings")
      .select("*")
      .eq("tenant_id", tenant_id)
      .maybeSingle();

    // Get OpenAI API key and model from tenant settings
    const openaiApiKey = aiSettings?.openai_api_key;
    const openaiModel = aiSettings?.openai_model || "gpt-4o-mini";

    if (!openaiApiKey) {
      return new Response(JSON.stringify({ success: false, error: "Chave da API OpenAI não configurada. Vá em Configurações para adicionar." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Load KB documents content
    const { data: kbDocs } = await adminClient
      .from("kb_documents")
      .select("title, doc_type, content")
      .eq("tenant_id", tenant_id)
      .eq("processing_status", "completed");

    // Build system prompt
    const toneMap: Record<string, string> = {
      amigavel: "Seja amigável e informal, use emojis moderadamente.",
      profissional: "Seja profissional e direto, mantenha tom corporativo.",
      formal: "Seja formal e respeitoso, use linguagem culta.",
    };

    let systemPrompt = "Você é um assistente de atendimento via WhatsApp.\n\n";

    if (aiSettings) {
      const tone = toneMap[aiSettings.tone] || toneMap.amigavel;
      systemPrompt += `## Tom de Voz\n${tone}\n\n`;

      if (aiSettings.general_instructions) {
        systemPrompt += `## Instruções Gerais\n${aiSettings.general_instructions}\n\n`;
      }
      if (aiSettings.formatting_style) {
        systemPrompt += `## Estilo de Formatação\n${aiSettings.formatting_style}\n\n`;
      }
      if (aiSettings.greeting) {
        systemPrompt += `## Saudação Padrão\nUse esta saudação ao iniciar: ${aiSettings.greeting}\n\n`;
      }
      if (aiSettings.farewell) {
        systemPrompt += `## Despedida Padrão\nUse esta despedida ao encerrar: ${aiSettings.farewell}\n\n`;
      }
      if (aiSettings.forbidden_responses) {
        systemPrompt += `## RESTRIÇÕES (NUNCA FAÇA ISSO)\n${aiSettings.forbidden_responses}\n\n`;
      }
      if (aiSettings.human_trigger_words) {
        systemPrompt += `## Palavras que exigem atendente humano\nSe o cliente mencionar: ${aiSettings.human_trigger_words}\nResponda que vai transferir para um atendente humano.\n\n`;
      }
      if (aiSettings.business_type) {
        systemPrompt += `## Tipo de Negócio\n${aiSettings.business_type}\n\n`;
      }
      if (aiSettings.business_hours) {
        systemPrompt += `## Horário de Funcionamento\n${aiSettings.business_hours}\n\n`;
      }
    }

    if (kbDocs && kbDocs.length > 0) {
      systemPrompt += `## Base de Conhecimento\nUse as informações abaixo para responder perguntas dos clientes:\n\n`;
      for (const doc of kbDocs) {
        if (doc.content) {
          systemPrompt += `### ${doc.title} (${doc.doc_type})\n${doc.content}\n\n`;
        }
      }
    }

    systemPrompt += "\n## Regras Finais\n" +
      "- Priorize SEMPRE as informações da 'Base de Conhecimento' acima para responder.\n" +
      "- Se a informação NÃO estiver na base de conhecimento, informe educadamente que não possui essa informação específica no momento.\n" +
      "- Responda de forma natural a saudações (olá, bom dia, etc), mas direcione o assunto para o suporte baseado nos documentos.\n" +
      "- Mantenha respostas curtas e objetivas, ideais para leitura no celular (WhatsApp).\n" +
      "- Use Português do Brasil.\n" +
      "- IMPORTANTE: O WhatsApp NÃO suporta formatação Markdown complexa (hashtags #, listas com traço -, blocos de código, etc).\n" +
      "- Para destacar palavras, use apenas UM asterisco de cada lado: *exemplo*. NUNCA use dois asteriscos **.\n" +
      "- Não use negrito em frases longas, apenas em palavras-chave.\n" +
      "- Escreva texto limpo, direto e sem marcações de cabeçalho.";

    // Call OpenAI API directly
    const aiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: openaiModel,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        stream: true,
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ success: false, error: "Rate limit da OpenAI excedido. Tente novamente em instantes." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 401) {
        return new Response(JSON.stringify({ success: false, error: "Chave da API OpenAI inválida. Verifique em Configurações." }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402 || aiResponse.status === 403) {
        return new Response(JSON.stringify({ success: false, error: "Conta OpenAI sem créditos ou sem acesso ao modelo selecionado." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await aiResponse.text();
      console.error("OpenAI error:", aiResponse.status, errText);
      return new Response(JSON.stringify({ success: false, error: "Erro na API da OpenAI" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(aiResponse.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("chat-ai error:", e);
    return new Response(JSON.stringify({ success: false, error: e instanceof Error ? e.message : "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
