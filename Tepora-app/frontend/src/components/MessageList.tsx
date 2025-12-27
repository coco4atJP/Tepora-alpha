import React, { useRef, useEffect } from 'react';
import MessageBubble from '../components/MessageBubble';
import { Message } from '../types';
import { Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface MessageListProps {
    messages: Message[];
}

const MessageList: React.FC<MessageListProps> = ({ messages }) => {
    const bottomRef = useRef<HTMLDivElement>(null);
    const { t } = useTranslation();

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    if (messages.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-tea-200/50">
                <Terminal className="w-12 h-12 mb-4 opacity-50" />
                <p className="text-sm font-mono tracking-widest uppercase">{t('dial.chat')} {t('status.ready')}</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-6">
            {messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
            ))}
            <div ref={bottomRef} />
        </div>
    );
};

export default MessageList;
