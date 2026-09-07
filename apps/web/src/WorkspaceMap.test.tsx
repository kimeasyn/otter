import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { WorkspaceMap, type Tree } from './App';
test('shows measured divergence and opens the actual selected worktree',()=>{
  const tree:Tree={id:'t',path:'/repo/work',branch:'feat/parser',head:'1234567890',ahead:3,behind:2,dirty:true,missing:false,warning:null,agents:[{name:'Builder',provider:'fake',status:'idle'}],changed_files:['parser.rs']};
  const onSelect=vi.fn();render(<WorkspaceMap trees={[tree]} base="main" onSelect={onSelect}/>);
  expect(screen.getByText('↑3 ↓2')).toBeInTheDocument();
  expect(screen.getByText('Uncommitted')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button'));
  expect(onSelect).toHaveBeenCalledWith(tree);
});
test('does not present missing observations as clean zero-divergence state',()=>{
  render(<WorkspaceMap trees={[{id:'t',path:'/missing',branch:null,head:'abc',ahead:null,behind:null,dirty:false,missing:true,warning:'missing',agents:[],changed_files:[]}]} base="main" onSelect={()=>{}}/>);
  expect(screen.getByText('↑? ↓?')).toBeInTheDocument();
  expect(screen.getByText('Unavailable')).toBeInTheDocument();
});
