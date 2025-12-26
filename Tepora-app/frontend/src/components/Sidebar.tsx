import React from 'react';
import { NavLink } from 'react-router-dom';
import { MessageSquare, Settings, FileText, Database } from 'lucide-react';

const Sidebar: React.FC = () => {
    const navItems = [
        { icon: MessageSquare, label: 'Chat', path: '/' },
        { icon: Settings, label: 'Settings', path: '/settings' },
        { icon: FileText, label: 'Logs', path: '/logs' },
        { icon: Database, label: 'Memory', path: '/memory' },
    ];

    return (
        <div className="w-64 bg-gray-900 text-white flex flex-col border-r border-gray-800">
            <div className="p-4 border-b border-gray-800 flex items-center gap-2">
                <div className="w-8 h-8 bg-primary-600 rounded-lg flex items-center justify-center">
                    <span className="text-xl font-bold">T</span>
                </div>
                <h1 className="text-xl font-bold">Tepora</h1>
            </div>

            <nav className="flex-1 p-4 space-y-2">
                {navItems.map((item) => (
                    <NavLink
                        key={item.path}
                        to={item.path}
                        className={({ isActive }) =>
                            `flex items-center gap-3 px-4 py-3 rounded-lg transition-colors ${isActive
                                ? 'bg-primary-600 text-white'
                                : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                            }`
                        }
                    >
                        <item.icon className="w-5 h-5" />
                        <span>{item.label}</span>
                    </NavLink>
                ))}
            </nav>

            <div className="p-4 border-t border-gray-800">
                <div className="text-xs text-gray-500 text-center">
                    v1.0.0 - EM-LLM Enabled
                </div>
            </div>
        </div>
    );
};

export default Sidebar;
